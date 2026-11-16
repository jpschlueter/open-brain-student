/**
 * Splits a thought's content into retrievable chunks.
 *
 * STRATEGY: paragraph packing, with hard-split fallback and backward overlap.
 *
 * Why not fixed-width windows: they cut mid-sentence, which strands the subject of a sentence
 * in one chunk and its predicate in the next. Retrieval quality drops on exactly the specific,
 * detail-level queries chunking exists to serve.
 *
 * Why not one chunk per paragraph: a chunk per paragraph produces vectors too small to carry
 * context, and any single oversized paragraph still blows past the embedding ceiling. Packing
 * paragraphs up to a soft target gets uniform chunk sizes without cutting sentences.
 *
 * Why not LLM-detected semantic sections: it costs a model call per capture, it is
 * nondeterministic (the same document chunks differently on re-run), and paragraph breaks
 * already ARE the section breaks in summarised, structured text.
 *
 * SIZING (chars, not tokens — content here is English/Spanish prose at ~4 chars/token)
 *   CHUNK_MIN_CONTENT 2000  below this the parent thought's own vector is not meaningfully
 *                           diluted, so chunking adds rows and API calls for nothing.
 *   CHUNK_TARGET_CHARS 1200 ~300 tokens. Large enough to carry context, small enough that one
 *                           buried detail is a meaningful fraction of the vector.
 *   CHUNK_MAX_CHARS 2000    hard cap; a single paragraph longer than this is split internally.
 *   CHUNK_OVERLAP_CHARS 200 carries the tail of the previous chunk so a passage spanning a
 *                           boundary is fully present in at least one chunk.
 *
 * Every chunk's text is an exact substring of the parent content, overlap included. Nothing is
 * rewritten, so a chunk can be highlighted in place in the original document.
 *
 * OFFSET ENCODING — charStart/charEnd are JavaScript string indices, i.e. UTF-16 code units.
 * `content.slice(charStart, charEnd)` is always exactly `text`. Postgres substring() counts
 * CODEPOINTS, so content with astral-plane characters (emoji) will disagree by one per emoji
 * preceding the offset. Treat the stored `content` column as the authoritative copy of a
 * chunk's text, and the offsets as a JS-side convenience, not a SQL contract.
 */

export interface TextChunk {
  index: number
  text: string
  charStart: number
  charEnd: number
}

export const CHUNK_MIN_CONTENT = 2000
export const CHUNK_TARGET_CHARS = 1200
export const CHUNK_MAX_CHARS = 2000
export const CHUNK_OVERLAP_CHARS = 200

export function shouldChunk(content: unknown): boolean {
  return typeof content === 'string' && content.length > CHUNK_MIN_CONTENT
}

/** Blank-line-separated paragraph spans as [start, end) offsets into content. */
function paragraphSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const separator = /\n[ \t]*\n+/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = separator.exec(content)) !== null) {
    if (m.index > cursor) spans.push([cursor, m.index])
    cursor = m.index + m[0].length
  }
  if (cursor < content.length) spans.push([cursor, content.length])
  return spans
}

/**
 * Split a span longer than CHUNK_MAX_CHARS, preferring a sentence break, then a word break.
 * The search window starts 60% into the cap so a boundary near the very start of the span
 * cannot produce a uselessly short piece.
 */
function splitLongSpan(content: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let s = start
  while (end - s > CHUNK_MAX_CHARS) {
    const hardLimit = s + CHUNK_MAX_CHARS
    const windowStart = s + Math.floor(CHUNK_MAX_CHARS * 0.6)
    const window = content.slice(windowStart, hardLimit)

    let cut = -1
    const sentence = window.lastIndexOf('. ')
    if (sentence !== -1) {
      cut = windowStart + sentence + 1 // keep the period with the chunk that owns the sentence
    } else {
      const space = window.lastIndexOf(' ')
      if (space !== -1) cut = windowStart + space
    }
    if (cut <= s) cut = hardLimit // no boundary anywhere in the window (e.g. a long token run)

    out.push([s, cut])
    s = cut
  }
  if (end > s) out.push([s, end])
  return out
}

export function chunkText(content: string): TextChunk[] {
  if (!shouldChunk(content)) return []

  // 1. Paragraph units, with any oversized paragraph split internally.
  const units: Array<[number, number]> = []
  for (const [s, e] of paragraphSpans(content)) {
    if (e - s > CHUNK_MAX_CHARS) units.push(...splitLongSpan(content, s, e))
    else units.push([s, e])
  }

  // 2. Pack units into cores.
  //
  //    Keep adding while the core is still SHORT OF the target, rather than only while the
  //    result would stay under it. With 600-char paragraphs and a 1200 target, "only while under
  //    target" would make every paragraph its own 600-char core — half the intended chunk size.
  //    Growing to at least the target means chunk size tracks the target, not paragraph length.
  //
  //    CHUNK_MAX_CHARS still caps the result, so a large unit landing on an under-target core
  //    starts a new core instead of producing an oversized one.
  const cores: Array<[number, number]> = []
  let coreStart = -1
  let coreEnd = -1
  for (const [s, e] of units) {
    if (coreStart === -1) {
      coreStart = s
      coreEnd = e
      continue
    }
    const coreLength = coreEnd - coreStart
    const lengthIfAdded = e - coreStart
    if (coreLength < CHUNK_TARGET_CHARS && lengthIfAdded <= CHUNK_MAX_CHARS) {
      coreEnd = e
    } else {
      cores.push([coreStart, coreEnd])
      coreStart = s
      coreEnd = e
    }
  }
  if (coreStart !== -1) cores.push([coreStart, coreEnd])

  const usable = cores.filter(([s, e]) => content.slice(s, e).trim().length > 0)

  // A single chunk would just duplicate the parent thought's own vector.
  if (usable.length < 2) return []

  // 3. Expand each core backwards for overlap, clamped so a chunk never swallows the whole
  //    of its predecessor. Text stays an exact substring of content.
  return usable.map(([cs, ce], i) => {
    if (i === 0) return { index: 0, text: content.slice(cs, ce), charStart: cs, charEnd: ce }

    const [prevStart, prevEnd] = usable[i - 1]
    let start = Math.max(prevStart, cs - CHUNK_OVERLAP_CHARS)

    // Snap forward to the next whitespace boundary. A fixed-offset overlap lands mid-word about
    // as often as not, and search results show the chunk verbatim — a section starting
    // "he next operating year..." reads as a truncation bug to whoever is looking at it.
    const limit = Math.min(cs, prevEnd)
    const relative = content.slice(start, limit).search(/\s/)
    if (relative !== -1 && start + relative + 1 < limit) start = start + relative + 1

    return { index: i, text: content.slice(start, ce), charStart: start, charEnd: ce }
  })
}
