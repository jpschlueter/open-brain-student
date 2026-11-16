/**
 * Writes per-chunk embeddings for a thought that is already saved.
 *
 * The parent thought keeps its own whole-content embedding. Chunks are additive: search takes
 * the better of the document-level match and the best chunk-level match. So if chunking fails,
 * retrieval degrades to exactly the pre-chunking behaviour rather than breaking — which is why
 * callers use saveThoughtChunksSafe.
 *
 * Embeds one chunk at a time through generateEmbedding rather than a batch call. A student's
 * capture is at most a few dozen chunks, so the extra round trips cost seconds, not minutes —
 * and one call per chunk is far easier to read than a batching layer this kit does not need.
 */

// Adapted for this project: embeddings come from our own gateway (llm.ts, Level 6),
// which has the same signature as Express's generateEmbedding.
import { embed as generateEmbedding } from './llm.ts'
import { chunkText, shouldChunk } from './chunking.ts'

/** Which text a chunk was cut from. A thought can hold both: its own summary, and — for
 *  captures that have one — the full source text it was summarised from. */
export type ChunkOrigin = 'summary' | 'source'

/**
 * Replaces a thought's chunks FOR ONE ORIGIN. Throws on failure.
 * Returns the number of chunks written (0 when the content is too short to be worth chunking).
 *
 * The origin scoping is load-bearing: a thought can hold both summary chunks (from
 * thoughts.content) and source chunks (from thought_sources.source_text). Re-chunking one must
 * not delete the other.
 */
export async function saveThoughtChunks(
  supabase: any,
  thoughtId: string,
  content: string,
  origin: ChunkOrigin = 'summary',
  userId?: string,
): Promise<number> {
  if (!thoughtId || !shouldChunk(content)) return 0

  let chunks = chunkText(content)

  // chunkText declines content that collapses to a single core, because one chunk would just
  // duplicate the parent vector. For content over CHUNK_MIN_CONTENT that should be unreachable,
  // but fall back to one whole-content chunk rather than writing nothing if it ever happens.
  if (chunks.length === 0) {
    console.warn(`[thought-chunks] ${thoughtId}: ${content.length} chars produced no chunks; storing whole content as one chunk`)
    chunks = [{ index: 0, text: content, charStart: 0, charEnd: content.length }]
  }

  const embeddings: (number[] | null)[] = []
  for (const c of chunks) {
    embeddings.push(await generateEmbedding(c.text, { userId, source: `chunk:${origin}` }))
  }

  const rows = chunks.map((c, i) => ({
    thought_id: thoughtId,
    origin,
    chunk_index: c.index,
    content: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    embedding: embeddings[i],
  }))

  // A chunk whose embedding call failed (rate limit, brief AI outage) is still written — the
  // embedding column is nullable, and the keyword arm of search does not require one. It is only
  // invisible to meaning-based search until the next re-chunk fills it in. This matches how the
  // rest of the kit treats a missing embedding everywhere else: degrade, do not lose the capture.
  const embedded = embeddings.filter((e) => e !== null).length
  if (embedded < chunks.length) {
    console.warn(`[thought-chunks] ${thoughtId}: ${embedded}/${chunks.length} chunks embedded — the rest are keyword-searchable only`)
  }

  // Delete-then-insert, not upsert: re-chunking content that got shorter must not leave stale
  // high-index chunks behind. Embeddings are generated before the delete so a failed API call
  // leaves the existing chunks untouched.
  const { error: delErr } = await supabase
    .from('thought_chunks').delete().eq('thought_id', thoughtId).eq('origin', origin)
  if (delErr) throw new Error(`chunk delete failed: ${delErr.message}`)

  const { error: insErr } = await supabase.from('thought_chunks').insert(rows)
  if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`)

  return rows.length
}

/**
 * Same, but never throws. The thought is already committed by the time this runs; losing its
 * chunks costs retrieval granularity, whereas throwing here would fail a capture that succeeded.
 */
export async function saveThoughtChunksSafe(
  supabase: any,
  thoughtId: string,
  content: string,
  label: string,
  origin: ChunkOrigin = 'summary',
  userId?: string,
): Promise<number> {
  try {
    return await saveThoughtChunks(supabase, thoughtId, content, origin, userId)
  } catch (err) {
    console.error(`[${label}] ${origin} chunking failed (non-fatal):`, String(err))
    return 0
  }
}
