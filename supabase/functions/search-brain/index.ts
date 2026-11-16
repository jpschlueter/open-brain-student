// ============================================================================
// SEARCH-BRAIN — the app's Search tab, upgraded to the same hybrid search
// Claude uses (meaning + exact keywords, chunk-aware, one-document cap).
// ============================================================================
// Why a server function and not a direct database call from the browser:
// searching by meaning needs an embedding of the search phrase, and making one
// needs your OpenRouter key — a secret that can never sit inside a web page.
//
// Who is asking comes from the caller's OWN login token, never from anything
// in the request body (a browser could put anything there). Deployed with
// --no-verify-jwt, so this function checks the login itself.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { embed } from '../_shared/llm.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' })

  try {
    // Who is asking? From their login token only.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await admin.auth.getUser(token)
    if (authError || !user) return json({ ok: false, error: 'Not signed in. Sign in to your app and try again.' })

    const body = await req.json().catch(() => ({}))
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 500) : ''
    if (!query) return json({ ok: false, error: 'Type something to search for.' })
    const n = Number(body.limit ?? 20)
    const limit = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 50) : 20

    // A failed embedding is not an error: search still runs on keywords alone
    const vector = await embed(query, { userId: user.id, source: 'app-search' })

    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: user.id,
      query_embedding: vector ? JSON.stringify(vector) : null,
      match_threshold: 0.3,
      match_count: limit,
      max_per_document: 2,
    })
    if (error) throw error

    return json({ ok: true, meaning_used: Boolean(vector), results: data ?? [] })
  } catch (err) {
    console.error('[search-brain] failed:', err)
    return json({ ok: false, error: 'Search failed. Try again in a moment.' })
  }
})
