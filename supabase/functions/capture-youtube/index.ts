// ============================================================================
// CAPTURE-YOUTUBE — paste a YouTube link, the transcript is fetched and saved
// ============================================================================
// WHY THIS NEEDS A SERVICE: YouTube deliberately hides captions from servers
// (anything coming from a data centre, which is what a Supabase function is).
// Rather than disguising this server as YouTube's own phone app to get around
// that block, it uses Supadata — a service built for fetching transcripts,
// with its own free tier (~100 videos/month). Your key lives in the
// SUPADATA_API_KEY secret.
//
// If there is no key, the free quota is used up, or the video has no captions,
// this function says so plainly ({ ok: false, needs_manual: true }) and your
// app shows the copy-and-paste box instead. It never silently saves something
// that is not the transcript.
//
// It saves the transcript as-is. Summarising needs an AI key you get in
// Level 5 — the enrichment agent there will summarise these captures for you.
//
// Deployed with --no-verify-jwt, so this function checks the caller's login
// itself (see "Who is asking?" below).
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''

const MAX_SAVED_CHARS = 200_000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Always 200 with { ok: true/false } so the app can show a friendly message
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

const ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([A-Za-z]+);/g, (m, n) =>
      n.toLowerCase() === 'amp' ? m : (ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m))
    .replace(/&#(\d+);/g, (m, d) => (+d === 38 || +d > 0x10ffff ? m : String.fromCodePoint(+d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) =>
      (parseInt(h, 16) === 38 || parseInt(h, 16) > 0x10ffff ? m : String.fromCodePoint(parseInt(h, 16))))
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
}

// Pull the 11-character video id out of any YouTube link shape
function extractVideoId(input: string): string | null {
  const patterns = [
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = input.trim().match(p)
    if (m) return m[1]
  }
  return null
}

// Title via YouTube's public oEmbed endpoint — no key needed
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(String(data.title))
    }
  } catch { /* fall through */ }
  return `YouTube video ${videoId}`
}

type TranscriptResult =
  | { ok: true; text: string; lang?: string }
  | { ok: false; reason: string }

async function fromSupadata(videoUrl: string): Promise<TranscriptResult> {
  if (!SUPADATA_KEY) {
    return { ok: false, reason: 'Automatic transcripts are not set up (no SUPADATA_API_KEY secret).' }
  }
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(30_000) },
    )
    if (!res.ok) {
      console.log(`[youtube] Supadata HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Supadata rejected the API key. Check SUPADATA_API_KEY.' }
      if (res.status === 402 || res.status === 429) return { ok: false, reason: 'Your free Supadata quota is used up for now.' }
      if (res.status === 404) return { ok: false, reason: 'This video has no transcript available.' }
      return { ok: false, reason: `The transcript service returned an error (HTTP ${res.status}).` }
    }
    const data = await res.json()
    // With text=true, content is one string; otherwise it is a list of segments
    const raw = typeof data?.content === 'string'
      ? data.content
      : Array.isArray(data?.content)
        ? data.content.map((s: { text?: string }) => s.text ?? '').join(' ')
        : ''
    const text = decodeEntities(raw).replace(/\s+/g, ' ').trim()
    if (!text) return { ok: false, reason: 'This video has no transcript available.' }
    return { ok: true, text, lang: data?.lang }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return { ok: false, reason: 'The transcript service did not respond in time.' }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' })

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // Who is asking? Taken from their login token — never from the request body.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await admin.auth.getUser(token)
    if (authError || !user) return json({ ok: false, error: 'Not signed in. Sign in to your app and try again.' })

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube link is required.' })

    const videoId = extractVideoId(url)
    if (!videoId) return json({ ok: false, error: 'That does not look like a YouTube link.' })

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    const result = await fromSupadata(videoUrl)
    if (!result.ok) {
      // Tell the app plainly; it will show the paste box as a fallback
      return json({ ok: false, needs_manual: true, video_id: videoId, title, error: result.reason })
    }

    const truncated = result.text.length > MAX_SAVED_CHARS
    const text = truncated ? result.text.slice(0, MAX_SAVED_CHARS) : result.text

    // Save — a plain insert, same shape as your Level 2 app. The service role key
    // skips the Level 2 security rule, so user_id is set by hand from the login above.
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content: `📹 YouTube: ${title}\n${videoUrl}\n\n${text}`,
        metadata: {
          source: 'youtube',
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: true,
          fetched_via: 'supadata',
          lang: result.lang ?? null,
        },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Keep the full transcript in thought_sources too. Non-fatal: the thought is already saved.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'youtube_transcript',
      char_count: text.length,
      truncated,
    })
    if (sourceError) console.warn('[capture-youtube] thought_sources insert failed:', sourceError.message)

    return json({ ok: true, title, video_id: videoId, chars: text.length, truncated })
  } catch (err) {
    console.error('[capture-youtube] Failed:', err)
    return json({ ok: false, error: 'Something went wrong capturing that video.' })
  }
})
