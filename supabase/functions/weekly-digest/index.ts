// ============================================================================
// WEEKLY-DIGEST — your brain writes you a report on your week
// ============================================================================
// Run by a schedule (pg_cron) every Sunday morning. It reads the last 7 days of
// thoughts, asks the AI (through the gateway) what you were learning, and:
//   • saves the digest as a new thought, category "digest"
//   • sends it to you on Telegram, if your bot is set up (Level 3)
//
// It runs without a password (--no-verify-jwt) and is protected by design:
// it only ever writes about YOUR thoughts, and it refuses to run more than
// once in 6 days, so nobody can make it spend your money by calling it.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { callLLM } from '../_shared/llm.ts'

const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('OWNER_TELEGRAM_CHAT_ID') ?? ''

const MIN_THOUGHTS = 5
const MAX_THOUGHTS = 200
const DAY = 24 * 60 * 60 * 1000

const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Row = { content: string; summary: string | null; category: string | null; tags: string[] | null; created_at: string }

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })
}

async function sendTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
    })
    if (!res.ok) console.warn('[digest] Telegram send failed:', res.status)
  } catch (e) {
    console.warn('[digest] Telegram send failed:', e)
  }
}

async function runDigest(): Promise<Record<string, unknown>> {
  if (!OWNER_USER_ID) return { ok: false, reason: 'OWNER_USER_ID secret is not set' }

  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * DAY)

  // 1. Already wrote one in the last 6 days? Then do nothing (protects your wallet)
  const { data: recent } = await db.from('thoughts').select('id')
    .eq('user_id', OWNER_USER_ID).eq('category', 'digest')
    .gte('created_at', new Date(now.getTime() - 6 * DAY).toISOString()).limit(1)
  if (recent && recent.length) {
    console.log('[digest] a digest was already written in the last 6 days; skipping')
    return { ok: true, skipped: 'already ran this week' }
  }

  // 2. The week's thoughts (not earlier digests)
  const { data, error } = await db.from('thoughts')
    .select('content, summary, category, tags, created_at')
    .eq('user_id', OWNER_USER_ID)
    .gte('created_at', weekAgo.toISOString())
    .or('category.is.null,category.neq.digest')
    .order('created_at', { ascending: true })
    .limit(MAX_THOUGHTS)
  if (error) throw error
  const rows = (data ?? []) as Row[]

  if (rows.length < MIN_THOUGHTS) {
    console.log(`[digest] only ${rows.length} thoughts this week (need ${MIN_THOUGHTS}); skipping`)
    return { ok: true, skipped: `only ${rows.length} thoughts this week` }
  }

  // 3. Group by category; use the enrichment summary where we have one
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    const key = r.category ?? 'uncategorized'
    const gist = r.summary?.trim() || r.content.replace(/\s+/g, ' ').trim().slice(0, 400)
    const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(`- (${shortDate(new Date(r.created_at))}) ${gist}${tags}`)
  }
  const material = [...groups.entries()]
    .map(([cat, items]) => `## ${cat} (${items.length})\n${items.join('\n')}`)
    .join('\n\n')

  // 4. Ask the AI, through the gateway
  const result = await callLLM({
    systemPrompt:
      'You write a short weekly review of a person\'s own notes for them, in the second person ("you"). ' +
      'Be specific and concrete, use their actual topics, never pad. Plain text only: no markdown symbols ' +
      'like # or **, because it will be read in a chat app.',
    prompt:
      `Here is everything I saved between ${shortDate(weekAgo)} and ${shortDate(now)}, grouped by category.\n\n` +
      `${material}\n\n` +
      'Write my weekly digest, under 300 words, with these parts:\n' +
      'WHAT YOU WERE LEARNING: 3 to 5 short points, grouped by subject.\n' +
      'THEMES: the 2 or 3 threads that kept coming back.\n' +
      'A QUESTION YOU SEEM TO BE EXPLORING: one sentence.\n' +
      'ONE NEXT STEP: one concrete suggestion based on the notes.',
    maxTokens: 3000,
    effort: 'medium',
    userId: OWNER_USER_ID,
    source: 'weekly-digest',
  })

  const heading = `🗓️ Weekly digest: ${shortDate(weekAgo)} to ${shortDate(now)} (${rows.length} thoughts)`
  const content = `${heading}\n\n${result.text}`

  // 5. Save it as a thought. enriched_at is set so the enrichment agent skips it.
  const { error: insertError } = await db.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content,
    category: 'digest',
    tags: ['weekly-digest'],
    summary: `Weekly digest of ${rows.length} thoughts, ${shortDate(weekAgo)} to ${shortDate(now)}.`,
    enriched_at: now.toISOString(),
    metadata: { source: 'weekly-digest', period_start: weekAgo.toISOString(), period_end: now.toISOString(), thought_count: rows.length },
  })
  if (insertError) throw insertError

  // 6. Deliver it on Telegram (optional, never fails the run)
  await sendTelegram(content)

  console.log(`[digest] written from ${rows.length} thoughts`)
  return { ok: true, thoughts: rows.length }
}

Deno.serve((req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })
  // Reply at once (the scheduler only waits a few seconds), then work in the background
  const work = runDigest()
    .then((r) => console.log('[digest] result:', JSON.stringify(r)))
    .catch((e) => console.error('[digest] failed:', e))
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime?.waitUntil?.(work)
  return new Response(JSON.stringify({ ok: true, started: true }), {
    status: 202, headers: { 'Content-Type': 'application/json' },
  })
})
