// ============================================================================
// CAPTURE-URL — paste an article link, the server fetches it and saves the text
// ============================================================================
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// fetch pages from other websites (that rule is called CORS). A server has no
// such limit, so the app hands the link to this function and it does the fetch.
//
// It saves the readable text as-is. Summarising needs an AI key you get in
// Level 5 — the enrichment agent there will summarise these captures for you.
//
// Deployed with --no-verify-jwt, so this function checks the caller's login
// itself (see "Who is asking?" below).
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_PAGE_BYTES = 3_000_000   // don't try to swallow a giant page
const MAX_SAVED_CHARS = 200_000    // plenty for any article

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

// Same idea as the decodeEntities in your app: turn &rsquo; &ntilde; etc. back
// into real characters, decoding &amp; LAST.
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

// Strip a web page down to its readable text (logic adapted from Open Brain Express)
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : 'Untitled page'

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

// Refuse addresses that point at private/internal networks
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || h.startsWith('fe80') || h.startsWith('::ffff:')
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [+m[1], +m[2]]
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' })

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // Who is asking? Taken from their login token — never from the request body,
    // or anyone could write into anyone else's brain.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await admin.auth.getUser(token)
    if (authError || !user) return json({ ok: false, error: 'Not signed in. Sign in to your app and try again.' })

    const { url, collection: rawCollection } = await req.json().catch(() => ({}))
    // Optional folder/collection name from bulk import, e.g. "EMS Research"
    const collection = typeof rawCollection === 'string' ? rawCollection.trim().slice(0, 80) : ''
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A link is required.' })

    let parsed: URL
    try { parsed = new URL(url.trim()) } catch { return json({ ok: false, error: 'That is not a valid web address.' }) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported.' })
    }
    if (isBlockedHost(parsed.hostname)) return json({ ok: false, error: 'That address is not allowed.' })

    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OpenBrain/1.0; personal reading capture)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers. Paste the text yourself instead.`,
      })
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, download it and use the PDF tab.`,
      })
    }
    const declared = Number(pageRes.headers.get('content-length') ?? 0)
    if (declared > MAX_PAGE_BYTES) return json({ ok: false, error: 'That page is too large to capture.' })

    const raw = await pageRes.text()
    if (raw.length > MAX_PAGE_BYTES) return json({ ok: false, error: 'That page is too large to capture.' })

    const { title, text: fullText } = htmlToText(raw)
    if (fullText.length < 200) {
      return json({
        ok: false,
        error: 'Almost no readable text was found. The page probably builds itself with JavaScript, which a server cannot see. Paste the text yourself instead.',
      })
    }

    const truncated = fullText.length > MAX_SAVED_CHARS
    const text = truncated ? fullText.slice(0, MAX_SAVED_CHARS) : fullText
    const finalUrl = pageRes.url || parsed.toString()

    // Save — a plain insert, same shape as your Level 2 app. The service role key
    // skips the Level 2 security rule, so user_id is set by hand from the login above.
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content: `🔗 URL: ${finalUrl}\n${title}${collection ? `\n📁 ${collection}` : ''}\n\n${text}`,
        metadata: {
          source: 'url', title, url: finalUrl, requested_url: parsed.toString(),
          hostname: new URL(finalUrl).hostname,
          ...(collection ? { collection } : {}),
        },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Keep the full text in thought_sources too. Non-fatal: the thought is already saved.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated,
    })
    if (sourceError) console.warn('[capture-url] thought_sources insert failed:', sourceError.message)

    return json({ ok: true, title, chars: text.length, truncated })
  } catch (err) {
    console.error('[capture-url] Failed:', err)
    const msg = String(err).toLowerCase().includes('timeout')
      ? 'That page took too long to respond.'
      : 'Something went wrong capturing that page.'
    return json({ ok: false, error: msg })
  }
})
