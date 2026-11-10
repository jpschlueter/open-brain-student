// ============================================================================
// ENRICH-THOUGHT — the enrichment agent
// ============================================================================
// Adds tags, a category, and a one-sentence summary to thoughts that don't
// have them yet. It is "poked" two ways:
//   1. A database webhook, the moment a new thought is saved
//   2. A safety-net schedule every 15 minutes (catches anything missed, and
//      works through older thoughts saved before this agent existed)
//
// It never trusts what the caller sends. Whoever pokes it, it only looks in
// your own table for rows with enriched_at still empty. So the worst anyone
// could do by calling it is make it enrich thoughts that needed enriching
// anyway. That is why it can run without a password (--no-verify-jwt).
//
// Every AI call goes through the gateway in ../_shared/llm.ts.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { callLLM, parseJSON } from '../_shared/llm.ts'

const BATCH = 8               // thoughts per run, keeps each run short
const MIN_CHARS = 20          // shorter than this: nothing worth tagging
const MAX_INPUT_CHARS = 12_000 // long transcripts: the first ~3,000 words is plenty for tags

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection'] as const

const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const SYSTEM_PROMPT =
  'You organize notes in a personal knowledge base. For each note you return short ' +
  'lowercase tags (topics someone would search for), one category, and a one-sentence ' +
  'summary written for the note\'s owner. Be concrete: name the actual topic, not "notes" or "misc".'

const SCHEMA = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' }, description: '3 to 5 short lowercase tags' },
    category: { type: 'string', enum: [...CATEGORIES] },
    summary: { type: 'string', description: 'One sentence, under 30 words' },
  },
  required: ['tags', 'category', 'summary'],
  additionalProperties: false,
}

type Enrichment = { tags: string[]; category: string; summary: string }
type Row = { id: string; user_id: string; content: string }

async function enrichOne(row: Row): Promise<'enriched' | 'skipped' | 'failed'> {
  // Claim the row first, so two runs at the same moment never pay twice for it
  const { data: claimed } = await db
    .from('thoughts')
    .update({ enriched_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('enriched_at', null)
    .select('id')
  if (!claimed || claimed.length === 0) return 'skipped'

  const content = (row.content ?? '').trim()
  if (content.length < MIN_CHARS) return 'skipped' // stays marked, never retried

  const excerpt = content.length > MAX_INPUT_CHARS
    ? content.slice(0, MAX_INPUT_CHARS) + '\n[…note continues]'
    : content

  try {
    const result = await callLLM({
      systemPrompt: SYSTEM_PROMPT,
      prompt:
        'Tag, categorize, and summarize this note.\n' +
        'Categories: idea (something to try or build), learning (something learned or taught), ' +
        'question (an open question), reference (an article, video, or document saved for later), ' +
        'plan (a goal or to-do), reflection (a personal thought or opinion).\n\n' +
        `<note>\n${excerpt}\n</note>`,
      jsonSchema: SCHEMA,
      maxTokens: 1500,
      effort: 'low',
      userId: row.user_id,
      source: 'enrich-thought',
    })

    const e = parseJSON<Enrichment>(result.text)
    if (!e) {
      console.warn(`[enrich] could not read the AI's answer for ${row.id}; leaving it un-tagged`)
      return 'failed' // stays marked so it is not retried (and re-billed) forever
    }

    const tags = Array.from(new Set((e.tags ?? [])
      .map((t) => String(t).toLowerCase().trim().replace(/^#/, ''))
      .filter((t) => t && t.length <= 40))).slice(0, 5)
    const category = CATEGORIES.includes(e.category as typeof CATEGORIES[number]) ? e.category : null
    const summary = String(e.summary ?? '').trim().slice(0, 400) || null

    const { error } = await db.from('thoughts').update({ tags, category, summary }).eq('id', row.id)
    if (error) throw error
    return 'enriched'
  } catch (err) {
    // The AI call itself failed (network, key, quota): un-claim so a later run retries
    console.error(`[enrich] ${row.id} failed:`, err)
    await db.from('thoughts').update({ enriched_at: null }).eq('id', row.id)
    return 'failed'
  }
}

Deno.serve((req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })
  // Answer the caller right away (webhooks only wait a few seconds), then do
  // the work in the background. The run's results show up in the function Logs.
  const work = runBatch()
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(work)
    return new Response(JSON.stringify({ ok: true, started: true }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    })
  }
  return work // (only when running somewhere without background work support)
})

async function runBatch(): Promise<Response> {
  try {
    // Ignore whatever was sent; just look for thoughts that still need enriching
    const { data: rows, error } = await db
      .from('thoughts')
      .select('id, user_id, content')
      .is('enriched_at', null)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(BATCH)
    if (error) throw error

    const counts = { enriched: 0, skipped: 0, failed: 0 }
    for (const row of rows ?? []) counts[await enrichOne(row as Row)]++

    console.log('[enrich] run finished:', counts)
    return new Response(JSON.stringify({ ok: true, ...counts }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[enrich] run failed:', err)
    // Always 200: webhooks and schedules should never retry-storm
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}
