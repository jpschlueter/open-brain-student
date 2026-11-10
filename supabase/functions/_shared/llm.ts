// ============================================================================
// THE LLM GATEWAY — every AI call in Open Brain goes through callLLM() here.
// ============================================================================
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// To switch models (cheaper, smarter, newer), change LLM_MODEL in Supabase
// secrets. No code changes, no redeploy of your agents' logic.
//
// Why a shared module and not its own web address: if the gateway were a
// separate edge function, it would be a public URL that spends your money.
// As a shared file it only exists INSIDE your other functions, so nobody on
// the internet can call it. Same one-place-to-change benefit, no open door.
//
// Secrets it reads:
//   LLM_PROVIDER        "anthropic" (default). Add another case below to support more.
//   LLM_MODEL           e.g. "claude-haiku-5-5"
//   ANTHROPIC_API_KEY   your key from console.anthropic.com / platform.claude.com
// ============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const PROVIDER = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').trim().toLowerCase()
const DEFAULT_MODEL = (Deno.env.get('LLM_MODEL') ?? '').trim()

// Published prices in US dollars per 1 million tokens, used for the receipt in
// llm_usage. A model missing from this list is still logged, with cost 0.
// Check current prices at https://platform.claude.com/docs/en/about-claude/pricing
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
}

export interface LLMRequest {
  prompt: string
  systemPrompt?: string
  model?: string          // normally leave empty and use LLM_MODEL
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high'
  jsonSchema?: Record<string, unknown> // ask for JSON matching this schema
  userId?: string         // who to bill this call to (for the receipt)
  source?: string         // which function spent it, e.g. "enrich-thought"
}

export interface LLMResult {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
}

export async function callLLM(req: LLMRequest): Promise<LLMResult> {
  const model = (req.model ?? DEFAULT_MODEL).trim()
  if (!model) throw new Error('LLM_MODEL secret is not set')

  let result: LLMResult
  switch (PROVIDER) {
    case 'anthropic':
      result = await callAnthropic(req, model)
      break
    // To add another provider: add a case here (e.g. 'openai') with a small
    // function like callAnthropic below, and set its API key in secrets.
    default:
      throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}"`)
  }

  logUsage(req, result) // not awaited, can never fail the call
  return result
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------
let anthropic: Anthropic | null = null

async function callAnthropic(req: LLMRequest, model: string): Promise<LLMResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret is not set')
  anthropic ??= new Anthropic({ apiKey })

  const outputConfig: Record<string, unknown> = { effort: req.effort ?? 'low' }
  if (req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema }

  const response = await anthropic.messages.create({
    model,
    max_tokens: req.maxTokens ?? 2000,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    messages: [{ role: 'user', content: req.prompt }],
    // deno-lint-ignore no-explicit-any
    output_config: outputConfig as any,
  })

  if (response.stop_reason === 'refusal') throw new Error('The model declined this request')

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim()

  return {
    text,
    model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// The receipt. Fire-and-forget: a failed log must NEVER fail the AI call that
// triggered it — the AI already answered.
// ---------------------------------------------------------------------------
function logUsage(req: LLMRequest, r: LLMResult): void {
  try {
    if (!req.userId) return
    const price = PRICES[r.model]
    const cost = price ? (r.inputTokens * price.input + r.outputTokens * price.output) / 1_000_000 : 0
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const pending = Promise.resolve(admin.from('llm_usage').insert({
      user_id: req.userId,
      kind: 'chat',
      model: r.model,
      source: req.source ?? null,
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      cost_usd: cost,
    })).then(({ error }) => {
      if (error) console.warn('[llm] usage log failed (ignored):', error.message)
    }, (e: unknown) => console.warn('[llm] usage log failed (ignored):', e))
    // Let the receipt finish writing even after the function has replied
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil?.(pending)
  } catch (e) {
    console.warn('[llm] usage log failed (ignored):', e)
  }
}

// Pull a JSON object out of model text, tolerating ```json fences
export function parseJSON<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { return JSON.parse(m[0]) as T } catch { return null }
  }
}
