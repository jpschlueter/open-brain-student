// Open Brain — Telegram bot (Supabase Edge Function)
//
// Telegram calls this function (a "webhook") every time someone messages your bot.
//   - a normal message      → saved as a new thought
//   - /search words  or ?words → keyword search, top 5 results
//   - /recent               → your last 5 thoughts
//   - /start or /help       → how to use the bot
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN       from BotFather
//   OWNER_USER_ID            your account's UID (Authentication → Users)
//   OWNER_TELEGRAM_CHAT_ID   your Telegram chat ID (the bot tells you this the first time)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  provided automatically by Supabase

import { createClient } from 'npm:@supabase/supabase-js@2'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const OWNER_CHAT_ID = Deno.env.get('OWNER_TELEGRAM_CHAT_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service role key skips the Level 2 security rule completely.
// That is why EVERY query below sets or filters user_id by hand.
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Telegram must always get a 200 back, or it keeps re-sending the same message.
function ok(): Response {
  return new Response('ok', { status: 200, headers: CORS })
}

// The webhook password is a fingerprint (SHA-256) of your bot token, so there
// is no extra secret to manage. Telegram sends it with every message; anyone
// else calling this address will not know it.
async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function reply(chatId: number | string, text: string): Promise<void> {
  if (text.length > 4000) text = text.slice(0, 3990) + '…' // Telegram's limit is 4096
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })
  if (!res.ok) console.error('Telegram sendMessage failed:', res.status, await res.text())
}

function preview(content: string, max = 280): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatList(rows: { content: string; created_at: string }[]): string {
  return rows.map((t, i) => `${i + 1}. ${preview(t.content)}\n   — ${shortDate(t.created_at)}`).join('\n\n')
}

const HELP =
  '🧠 Your Open Brain bot\n\n' +
  '• Send any message → saved to your brain\n' +
  '• /search word  (or ?word) → find thoughts containing it\n' +
  '• /recent → your last 5 thoughts\n' +
  '• /help → this message'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return ok()

  let chatId: number | null = null

  try {
    if (!TOKEN || !OWNER_USER_ID) {
      console.error('Missing secret: TELEGRAM_BOT_TOKEN and OWNER_USER_ID must both be set.')
      return ok()
    }

    // 1. Is this really Telegram? (The door is open because of --no-verify-jwt,
    //    so the function checks who is knocking itself.)
    const expected = await sha256Hex(TOKEN)
    if (req.headers.get('x-telegram-bot-api-secret-token') !== expected) {
      console.warn('Rejected a request without the correct webhook secret.')
      return new Response('unauthorized', { status: 401, headers: CORS })
    }

    const update = await req.json()
    const msg = update.message ?? update.edited_message
    if (!msg || !msg.chat) return ok() // not a chat message (e.g. someone added the bot to a group)
    chatId = msg.chat.id

    // 2. Is this YOUR chat? First time through, tell the owner their chat ID.
    if (!OWNER_CHAT_ID) {
      await reply(
        chatId!,
        `👋 Almost ready!\n\nYour Telegram chat ID is: ${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets with the name OWNER_TELEGRAM_CHAT_ID, ' +
          'then send me a message again. Until then I will not save or show anything.',
      )
      return ok()
    }
    if (String(chatId) !== OWNER_CHAT_ID.trim()) {
      await reply(chatId!, 'Sorry, this is a private brain.')
      return ok()
    }

    const text: string = (msg.text ?? msg.caption ?? '').trim()
    if (!text) {
      await reply(chatId!, 'I can only save text for now. Type your thought as a message.')
      return ok()
    }
    const lower = text.toLowerCase()

    // 3. Help
    if (/^\/(start|help)(@\w+)?$/.test(lower)) {
      await reply(chatId!, HELP)
      return ok()
    }

    // 4. Search
    if (/^\/search(@\w+)?(\s|$)/.test(lower) || text.startsWith('?')) {
      const query = text.startsWith('?') ? text.slice(1).trim() : text.replace(/^\/search(@\w+)?/i, '').trim()
      if (!query) {
        await reply(chatId!, 'What should I search for? Example: /search cpr')
        return ok()
      }
      const safe = query.replace(/[\\%_]/g, (m) => '\\' + m) // search % and _ literally
      const { data, error } = await db
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${safe}%`)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId!,
        data && data.length
          ? `🔍 Top ${data.length} for "${query}":\n\n${formatList(data)}`
          : `Nothing found for "${query}". Try a different word.`,
      )
      return ok()
    }

    // 5. Recent
    if (/^\/recent(@\w+)?$/.test(lower)) {
      const { data, error } = await db
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId!,
        data && data.length ? `🕘 Your last ${data.length} thoughts:\n\n${formatList(data)}` : 'Your brain is empty so far.',
      )
      return ok()
    }

    // 6. Any other /command is probably a typo — do not save it as a thought
    if (text.startsWith('/')) {
      await reply(chatId!, "I don't know that command.\n\n" + HELP)
      return ok()
    }

    // 7. Everything else is a thought: save it, owned by you
    const { error } = await db.from('thoughts').upsert({
      content: text,
      user_id: OWNER_USER_ID,
      metadata: { source: 'telegram' },
    }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
    if (error) throw error
    await reply(chatId!, '🧠 Saved to your brain.')
    return ok()
  } catch (e) {
    console.error('telegram-bot error:', e)
    if (chatId !== null) {
      try {
        await reply(chatId, '⚠️ Something went wrong. Nothing was saved. Try again in a moment.')
      } catch (_) { /* ignore */ }
    }
    return ok()
  }
})