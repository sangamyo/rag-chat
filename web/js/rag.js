/*
 * Retrieval core: chunking, BM25, vector similarity, hybrid fusion and prompt building.
 * Pure functions only (no DOM, no network) so the whole pipeline is unit-tested in Node.
 */

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

const normalizeSpace = (s) => s.replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** Split text into sentences, keeping the punctuation. Good enough for English prose and bullet lists. */
export function splitSentences(text) {
  // break after . ! ? only when followed by whitespace (so URLs, emails and 7.8 stay whole), and at newlines
  return text
    .split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9•"'(])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Pages -> overlapping chunks that respect paragraph and sentence boundaries.
 * @param {{doc: string, page: number|null, text: string}[]} pages
 * @param {{size?: number, overlap?: number}} opts  size/overlap in characters
 */
export function chunkPages(pages, { size = 900, overlap = 160 } = {}) {
  const chunks = []
  for (const { doc, page, text } of pages) {
    const paragraphs = normalizeSpace(text)
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, ' ').trim())
      .filter(Boolean)
    // break very long paragraphs into sentences so no unit is bigger than a chunk
    const units = paragraphs.flatMap((p) => (p.length > size ? splitSentences(p) : [p])).flatMap((u) => (u.length > size ? wordPieces(u, size) : [u]))
    let current = []
    let length = 0
    let fresh = false // does `current` hold text not yet emitted?
    const flush = () => {
      if (!fresh) return
      chunks.push({ id: chunks.length, doc, page, text: current.join('\n\n') })
      // carry the tail over as overlap so facts on a boundary appear in both chunks
      const carry = []
      let carried = 0
      for (let i = current.length - 1; i >= 0 && carried < overlap; i--) {
        if (carried + current[i].length > size * 0.5) break
        carry.unshift(current[i])
        carried += current[i].length
      }
      current = carry
      length = carried
      fresh = false
    }
    for (const unit of units) {
      if (length + unit.length > size && fresh) flush()
      current.push(unit)
      length += unit.length
      fresh = true
    }
    flush()
  }
  return chunks
}

/** Split an over-long run of text at word boundaries into pieces of at most `size` characters. */
function wordPieces(text, size) {
  const out = []
  let cur = ''
  for (const w of text.split(/\s+/)) {
    if (cur && cur.length + w.length + 1 > size) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${w}` : w
  }
  if (cur) out.push(cur)
  return out
}

/* ------------------------------------------------------------------ */
/* BM25 keyword search                                                 */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to was we were what when where which who whom why will with would you your about also just over under after before between both each few more most other some such only own same too very s t don should now'.split(' '),
)

const IRREGULAR = { built: 'build', builds: 'build', made: 'make', wrote: 'write', written: 'write', led: 'lead', ran: 'run', taught: 'teach', studied: 'study', studies: 'study', worked: 'work', works: 'work', working: 'work', used: 'use', uses: 'use', using: 'use' }

/** Lower-case word tokens with stop words removed and a light plural/verb stem. */
export function tokenize(text) {
  return (text.toLowerCase().normalize('NFKD').match(/[a-z0-9]+(?:[.+#][a-z0-9]+)*/g) || [])
    .filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)))
    .map((w) => IRREGULAR[w] ?? (w.length > 4 && !/[.+#]/.test(w) ? w.replace(/(ied|ies)$/, 'y').replace(/(ing|ed|es|s)$/, '') : w))
}

export function buildBM25(chunks, { k1 = 1.4, b = 0.75 } = {}) {
  const docs = chunks.map((c) => tokenize(c.text))
  const df = new Map()
  docs.forEach((terms) => new Set(terms).forEach((t) => df.set(t, (df.get(t) || 0) + 1)))
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length)
  const tf = docs.map((terms) => {
    const m = new Map()
    terms.forEach((t) => m.set(t, (m.get(t) || 0) + 1))
    return m
  })
  const N = docs.length
  const idf = (t) => {
    const n = df.get(t) || 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }
  return {
    idf,
    search(query, topK = 8) {
      const q = [...new Set(tokenize(query))]
      const scores = docs.map((terms, i) => {
        let s = 0
        for (const t of q) {
          const f = tf[i].get(t)
          if (!f) continue
          s += (idf(t) * f * (k1 + 1)) / (f + k1 * (1 - b + (b * terms.length) / avgdl))
        }
        return s
      })
      return rank(scores, topK)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Vectors + fusion                                                    */
/* ------------------------------------------------------------------ */

export function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Cosine similarity for already-normalised embeddings (bge outputs are normalised). */
export function vectorSearch(queryVec, vectors, topK = 8) {
  return rank(vectors.map((v) => dot(queryVec, v)), topK)
}

function rank(scores, topK) {
  return scores
    .map((score, index) => ({ index, score }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, topK)
}

/**
 * Reciprocal rank fusion: robust way to merge rankings whose scores aren't comparable.
 * Returns [{ index, score, via: Set('vector'|'keyword'), vectorScore?, keywordScore? }]
 */
export function fuse(lists, { k = 60, topK = 5 } = {}) {
  const out = new Map()
  for (const [name, list] of Object.entries(lists)) {
    list.forEach((r, rankPos) => {
      const e = out.get(r.index) || { index: r.index, score: 0, via: new Set() }
      e.score += 1 / (k + rankPos + 1)
      e.via.add(name)
      e[`${name}Score`] = r.score
      out.set(r.index, e)
    })
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}

/**
 * Hybrid retrieval. `minVector` drops weak semantic matches that keyword search didn't confirm,
 * so "no relevant passage" can be detected instead of always returning something.
 */
export function hybridSearch({ query, queryVec, chunks, vectors, bm25, topK = 5, minVector = 0.5 }) {
  const vec = queryVec ? vectorSearch(queryVec, vectors, 12) : []
  const kw = bm25.search(query, 12)
  const fused = fuse({ vector: vec, keyword: kw }, { topK: topK * 2 })
  const kept = []
  for (const r of fused) {
    if (!(r.via.has('keyword') || (r.vectorScore ?? 0) >= minVector)) continue
    // overlapping chunks can be near-identical; keep the better-ranked one
    const terms = new Set(tokenize(chunks[r.index].text))
    if (kept.some((k) => jaccard(k.terms, terms) > 0.8)) continue
    kept.push({ ...r, terms })
    if (kept.length === topK) break
  }
  return kept.map(({ terms, ...r }) => ({ ...r, chunk: chunks[r.index], via: [...r.via] }))
}

function jaccard(a, b) {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter || 1)
}

/* ------------------------------------------------------------------ */
/* Conversation helpers                                                */
/* ------------------------------------------------------------------ */

/** Follow-ups like "what about his education?" get the previous question folded in for retrieval. */
export function retrievalQuery(question, history = []) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content
  const vague = /\b(it|its|this|that|they|them|those|these|he|she|his|her|him|their|there|more|else|again|also)\b/i.test(question) || question.split(/\s+/).length <= 4
  return lastUser && vague ? `${lastUser} ${question}` : question
}

export const SYSTEM_PROMPT = [
  'You answer questions using ONLY the numbered sources provided.',
  'Rules:',
  '- Cite every fact with its source number in square brackets, like [1] or [2][3].',
  '- If the sources do not contain the answer, reply exactly: "I couldn\'t find that in the documents."',
  '- Do not use outside knowledge. Do not guess numbers, dates or names.',
  '- Be concise: at most 5 sentences or a short bullet list.',
  '- Answer about the exact person, project or thing named in the question; never move a fact from one source to another.',
  '',
  'Format: "<fact from a source> [n]. <another fact> [n][m]."',
].join('\n')

/** Build chat messages for the LLM, keeping the context within a character budget. */
export function buildMessages(question, passages, history = [], { budget = 5200 } = {}) {
  let used = 0
  const blocks = []
  passages.forEach((p, i) => {
    const where = p.chunk.page ? `${p.chunk.doc}, page ${p.chunk.page}` : p.chunk.doc
    const text = p.chunk.text.length > 1400 ? `${p.chunk.text.slice(0, 1400)}…` : p.chunk.text
    const block = `[${i + 1}] (${where})\n${text}`
    if (used + block.length > budget && blocks.length) return
    blocks.push(block)
    used += block.length
  })
  const recent = history.slice(-4).map((m) => ({ role: m.role, content: m.content.slice(0, 600) }))
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...recent,
    { role: 'user', content: `Sources:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question}\n\nAnswer with citations:` },
  ]
}

/** No-LLM fallback: the most relevant sentences from the top passages, each with its citation. */
/** The proper-noun subject of a question: "What did Hari Om build…" -> "Hari Om". */
export function questionSubject(question) {
  const m = question.match(/\b(?:did|does|do|is|was|has|have|are|were|can|could|will|would)\s+((?:[A-Z][\w.'-]*\s+){0,3}[A-Z][\w.'-]*)/)
  return m ? m[1] : ''
}

/** Long list-like lines become overlapping windows of words, so a fact inside them can still be picked. */
function windows(sentence, size = 24, step = 16) {
  const words = sentence.split(/\s+/)
  if (words.length <= 40) return [sentence]
  const out = []
  for (let i = 0; i < words.length; i += step) {
    const end = i + size >= words.length
    out.push(`${i ? '…' : ''}${words.slice(i, i + size).join(' ')}${end ? '' : '…'}`)
    if (end) break
  }
  return out
}

export function extractiveAnswer(question, passages, { maxSentences = 3, idf = () => 1 } = {}) {
  // the question's subject (e.g. a person's name) says who it's about, not what to look for
  const subject = new Set(tokenize(questionSubject(question)))
  const all = [...new Set(tokenize(question))]
  const qTerms = all.some((t) => !subject.has(t)) ? all.filter((t) => !subject.has(t)) : all
  const q = new Set(qTerms)
  // "key" terms are the rarer half of the question words; a sentence must contain one of them,
  // so a name that appears everywhere (e.g. "Hari Om") can't carry an answer on its own
  const present = new Set(passages.flatMap((p) => tokenize(p.chunk.text)))
  const inDocs = qTerms.filter((t) => present.has(t))
  const top = Math.max(0, ...inDocs.map(idf))
  const key = new Set(inDocs.filter((t) => idf(t) >= top * 0.75))
  const scored = []
  passages.forEach((p, i) => {
    // list-like lines without full stops are split at separators, then windowed, so one long line can't win by length
    const clauses = splitSentences(p.chunk.text)
      .flatMap((s) => (s.split(/\s+/).length > 40 ? s.split(/\s+\|\s+|;\s+|\s{2,}/) : [s]))
      .flatMap((s) => windows(s))
    clauses.forEach((s, j) => {
      const terms = tokenize(s)
      if (terms.length < 3) return
      const uniq = new Set(terms)
      if (![...key].some((t) => uniq.has(t))) return
      // rare question words (e.g. "addverb") count far more than common ones
      const weight = [...uniq].filter((t) => q.has(t)).reduce((n, t) => n + idf(t), 0)
      scored.push({ s, cite: i + 1, score: weight / Math.sqrt(Math.max(8, terms.length)) + (passages.length - i) * 0.03 - j * 0.005 })
    })
  })
  const picked = scored.sort((a, b) => b.score - a.score).slice(0, maxSentences)
  if (!picked.length) return "I couldn't find that in the documents."
  return picked.map((p) => `${p.s.replace(/\s+/g, ' ').trim()} [${p.cite}]`).join(' ')
}

export const NOT_FOUND = "I couldn't find that in the documents."

/** Tidy model output: drop echoed source headers like "(resume.pdf, page 1)" and stray leading numbers. */
export function cleanAnswer(text) {
  return text
    .replace(/\((?:[^()]*?\.(?:pdf|md|markdown|txt|html?))(?:,\s*page\s*\d+)?\)/gi, '')
    .replace(/^\s*(?:\d+\s+)(?=[A-Z(])/, '')
    .replace(/^\s*(?:answer|response)\s*:\s*/i, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Grounding check: share of the answer's content words (incl. numbers) that appear in the sources.
 * Small models sometimes invent facts and still add a citation; a low score catches that.
 */
export function support(answer, passages) {
  const words = tokenize(answer.replace(/\[\d+\]/g, ''))
  if (!words.length) return 1
  const source = new Set(passages.flatMap((p) => tokenize(p.chunk.text)))
  return words.filter((w) => source.has(w)).length / words.length
}

/**
 * Small models sometimes forget to cite. Give each uncited sentence the passage it overlaps most
 * (only when the overlap is meaningful), so every claim can still be checked.
 */
export function attachCitations(answer, passages) {
  if (answer.startsWith("I couldn't find")) return answer
  const sources = passages.map((p) => new Set(tokenize(p.chunk.text)))
  return splitSentences(answer)
    .map((s) => {
      if (/\[\d{1,2}\]/.test(s)) return s
      const terms = [...new Set(tokenize(s))]
      if (terms.length < 2) return s
      let best = -1
      let bestScore = 0
      sources.forEach((src, i) => {
        const score = terms.filter((t) => src.has(t)).length / terms.length
        if (score > bestScore) [best, bestScore] = [i, score]
      })
      return bestScore >= 0.5 ? s.replace(/([.!?]?)$/, ` [${best + 1}]$1`) : s
    })
    .join(' ')
}

/** Citation numbers actually used in an answer, e.g. "… [1][3]" -> [1, 3]. */
export function citedSources(answer) {
  return [...new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
}
