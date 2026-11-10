// ============================================================================
// OPEN BRAIN MCP SERVER
// ============================================================================
// MCP (Model Context Protocol) is an open standard that lets AI assistants use
// tools. This function is a small MCP server: an AI (Claude today, any
// MCP-compatible assistant tomorrow) sends it requests, and it answers from
// YOUR database.
//
// Requests and replies use JSON-RPC 2.0, a simple message format:
//   request:  { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
//   reply:    { "jsonrpc": "2.0", "id": 1, "result": { ... } }
//
// Tools offered to the AI:
//   search_thoughts  find thoughts containing words (keyword search)
//   list_recent      the most recent thoughts
//   get_thought      the full text of one thought (long transcripts are
//                    shortened in search results; this fetches all of it)
//   add_thought      save a new thought
// There is deliberately no delete or edit tool.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MCP_ACCESS_KEY   the password your AI must send ("Authorization: Bearer ...")
//   OWNER_USER_ID    your account's UID (set in Level 3)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deployed with --no-verify-jwt: Supabase's own login check would turn the AI
// away (it has no Supabase login), so this function checks MCP_ACCESS_KEY itself.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service role key skips the Level 2 security rule entirely, so EVERY query
// below filters by OWNER_USER_ID by hand, and add_thought stamps it on new rows.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const SERVER_INFO = { name: 'open-brain', version: '1.0.0' }
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const PREVIEW_CHARS = 2000 // long captures are shortened in lists; get_thought returns all

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
}

// ---------------------------------------------------------------------------
// The tool list the AI sees. "description" is what the AI reads to decide when
// to use each tool, so it is written for the AI.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'Open Brain': notes, voice notes, " +
      'YouTube transcripts, articles, PDFs, Telegram messages) for thoughts containing ALL of the ' +
      'given words. Use short keywords (1-3 words), and try synonyms if nothing is found. ' +
      'Returns up to 10 matches, newest first; long items are shortened, use get_thought for full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to look for, e.g. "airway" or "tourniquet"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: "List the most recently saved thoughts in the user's Open Brain, newest first.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return (1-50, default 10)', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'get_thought',
    description: 'Get the full text of one thought by its id (ids are shown in search and list results).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The thought id' } },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to save, " +
      'remember, or capture something.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function http(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

// Tool results are text the AI reads. isError tells the AI the tool failed.
function toolText(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

// Compare passwords without leaking timing information
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

type Row = { id: string; content: string; created_at: string }

function formatRows(rows: Row[], heading: string): string {
  if (!rows.length) return heading + '\n\n(no thoughts found)'
  return heading + '\n\n' + rows.map((r, i) => {
    const text = r.content.length > PREVIEW_CHARS
      ? r.content.slice(0, PREVIEW_CHARS) + `\n[…shortened: ${r.content.length.toLocaleString()} characters in total. Call get_thought with this id for the full text.]`
      : r.content
    return `--- ${i + 1}. id: ${r.id} | saved: ${r.created_at.slice(0, 10)} ---\n${text}`
  }).join('\n\n')
}

// ---------------------------------------------------------------------------
// The tools themselves
// ---------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'search_thoughts': {
      const query = String(args.query ?? '').trim()
      if (!query) return toolText('Please provide a search query.', true)
      // Every word must appear (in any order). % and _ are searched literally.
      const words = query.split(/\s+/).filter(Boolean).slice(0, 6)
      let q = db.from('thoughts').select('id, content, created_at').eq('user_id', OWNER_USER_ID)
      for (const w of words) q = q.ilike('content', `%${w.replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(10)
      if (error) throw error
      return toolText(formatRows(data ?? [], `Search results for "${query}" (${data?.length ?? 0}):`))
    }

    case 'list_recent': {
      const n = Number(args.limit ?? 10)
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 50) : 10
      const { data, error } = await db
        .from('thoughts').select('id, content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false }).limit(limit)
      if (error) throw error
      return toolText(formatRows(data ?? [], `The ${data?.length ?? 0} most recent thoughts:`))
    }

    case 'get_thought': {
      const id = String(args.id ?? '').trim()
      if (!/^[0-9a-f-]{36}$/i.test(id)) return toolText('That is not a valid thought id.', true)
      const { data, error } = await db
        .from('thoughts').select('id, content, created_at')
        .eq('user_id', OWNER_USER_ID).eq('id', id).maybeSingle()
      if (error) throw error
      if (!data) return toolText('No thought with that id.', true)
      return toolText(`id: ${data.id} | saved: ${data.created_at.slice(0, 10)}\n\n${data.content}`)
    }

    case 'add_thought': {
      const content = String(args.content ?? '').trim()
      if (!content) return toolText('Nothing to save: content is empty.', true)
      if (content.length > 20_000) return toolText('That is too long to save in one thought (max 20,000 characters).', true)
      const { data, error } = await db
        .from('thoughts')
        .insert({ content, user_id: OWNER_USER_ID, metadata: { source: 'mcp' } })
        .select('id, created_at').single()
      if (error) throw error
      return toolText(`Saved to the Open Brain (id: ${data.id}, ${data.created_at.slice(0, 10)}).`)
    }

    default:
      return null // unknown tool
  }
}

// ---------------------------------------------------------------------------
// Handle one JSON-RPC message. Returns null for notifications (no reply needed).
// ---------------------------------------------------------------------------
async function handleMessage(msg: any) {
  const isNotification = msg?.id === undefined || msg?.id === null
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(msg?.id, -32600, 'Invalid request')
  }
  if (isNotification) return null // e.g. "notifications/initialized"

  const { id, method, params } = msg
  switch (method) {
    // First message from the AI: agree on a protocol version and say what we offer
    case 'initialize': {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0]
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Tools for the user's personal knowledge base (Open Brain). Search it whenever the user " +
          'asks about something they may have saved, read, watched, or noted.',
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = String(params?.name ?? '')
      try {
        const result = await callTool(name, params?.arguments ?? {})
        return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${name}`)
      } catch (e) {
        console.error(`[open-brain-mcp] ${name} failed:`, e)
        return rpcResult(id, toolText('The database request failed. Try again in a moment.', true))
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// The web entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // 1. Check the password before doing anything else
  if (!ACCESS_KEY || !OWNER_USER_ID) {
    console.error('[open-brain-mcp] MCP_ACCESS_KEY and OWNER_USER_ID secrets must both be set.')
    return http(rpcError(null, -32603, 'Server is not configured'), 500)
  }
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!safeEqual(token, ACCESS_KEY)) {
    return http(rpcError(null, -32001, 'Unauthorized: wrong or missing MCP access key'), 401)
  }

  // 2. This server answers plain POST requests only (no streaming)
  if (req.method !== 'POST') return http(rpcError(null, -32000, 'Method not allowed'), 405)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return http(rpcError(null, -32700, 'Parse error: body is not valid JSON'), 400)
  }

  // 3. One message, or a batch (list) of messages
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handleMessage))).filter((r) => r !== null)
    return replies.length ? http(replies) : new Response(null, { status: 202, headers: CORS })
  }
  const reply = await handleMessage(body)
  return reply ? http(reply) : new Response(null, { status: 202, headers: CORS })
})
