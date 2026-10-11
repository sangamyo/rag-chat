import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBM25, buildMessages, chunkPages, citedSources, cleanAnswer, extractiveAnswer, fuse, hybridSearch, retrievalQuery, splitSentences, support, tokenize, vectorSearch } from './rag.js'
import { pageText, stripMarkdown } from './ingest.js'

const para = (n, word) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i} about ${word}.`).join(' ')

test('chunks respect size, keep page numbers and overlap', () => {
  const pages = [
    { doc: 'a.pdf', page: 1, text: `${para(12, 'alpha')}\n\n${para(12, 'beta')}\n\n${para(12, 'gamma')}` },
    { doc: 'a.pdf', page: 2, text: 'Short last page.' },
  ]
  const chunks = chunkPages(pages, { size: 500, overlap: 120 })
  assert.ok(chunks.length >= 4)
  assert.ok(chunks.every((c) => c.text.length <= 500 + 400), 'no chunk is wildly over size')
  assert.deepEqual(chunks.map((c) => c.id), chunks.map((_, i) => i))
  assert.equal(chunks.at(-1).page, 2)
  assert.equal(chunks.at(-1).text, 'Short last page.')
  // every sentence of the source appears somewhere
  for (const w of ['alpha', 'beta', 'gamma']) assert.ok(chunks.some((c) => c.text.includes(`${w} sentence number 11`)), w)
})

test('a page never produces an overlap-only chunk', () => {
  const chunks = chunkPages([{ doc: 'x.md', page: null, text: 'One paragraph only.' }], { size: 900 })
  assert.equal(chunks.length, 1)
})

test('sentences and tokens', () => {
  assert.deepEqual(splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!'])
  assert.deepEqual(tokenize('The robots were Recording datasets in LeRobot format'), ['robot', 'record', 'dataset', 'lerobot', 'format'])
  assert.ok(tokenize('Node.js and C++ and pgvector').includes('node.js'))
})

const corpus = [
  { id: 0, doc: 'resume.pdf', page: 1, text: 'Robotics & AI Intern at Addverb Technologies. Built teleoperated robot-manipulation datasets used to train VLA models.' },
  { id: 1, doc: 'resume.pdf', page: 1, text: 'Full Stack Developer Intern at PureWashr. Built a MERN platform serving 500+ active users.' },
  { id: 2, doc: 'resume.pdf', page: 1, text: 'B.Tech in Computer Science, G L Bajaj Institute, CGPA 7.8.' },
  { id: 3, doc: 'notes.md', page: null, text: 'Weekend plans: hiking and cooking pasta.' },
]

test('BM25 ranks the matching chunk first', () => {
  const bm25 = buildBM25(corpus)
  assert.equal(bm25.search('What did he do at Addverb?')[0].index, 0)
  assert.equal(bm25.search('MERN users')[0].index, 1)
  assert.deepEqual(bm25.search('quantum chromodynamics'), [])
})

test('vector search and reciprocal rank fusion', () => {
  const vecs = [[1, 0], [0, 1], [0.7, 0.7], [-1, 0]]
  assert.deepEqual(vectorSearch([1, 0], vecs, 2).map((r) => r.index), [0, 2])
  const fused = fuse({ vector: [{ index: 2, score: 0.9 }, { index: 0, score: 0.8 }], keyword: [{ index: 0, score: 5 }, { index: 1, score: 2 }] })
  assert.equal(fused[0].index, 0, 'found by both methods wins')
  assert.deepEqual([...fused[0].via].sort(), ['keyword', 'vector'])
})

test('hybrid search drops weak semantic-only matches', () => {
  const bm25 = buildBM25(corpus)
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, 0.3, 0.3]]
  const hits = hybridSearch({ query: 'zzz', queryVec: [0.4, 0.2, 0.1], chunks: corpus, vectors, bm25 })
  assert.deepEqual(hits, [], 'nothing relevant -> nothing returned')
  const good = hybridSearch({ query: 'Addverb datasets', queryVec: [0.95, 0.1, 0], chunks: corpus, vectors, bm25 })
  assert.equal(good[0].chunk.id, 0)
})

test('follow-up questions borrow the previous question for retrieval', () => {
  const history = [{ role: 'user', content: 'What did Hari Om do at Addverb?' }, { role: 'assistant', content: '…' }]
  assert.equal(retrievalQuery('what tools did he use?', history), 'What did Hari Om do at Addverb? what tools did he use?')
  assert.equal(retrievalQuery('Where did Hari Om study computer science?', history), 'Where did Hari Om study computer science?')
})

test('prompt numbers sources, cites pages and stays within budget', () => {
  const passages = corpus.slice(0, 3).map((chunk) => ({ chunk }))
  const msgs = buildMessages('Where did he study?', passages, [], { budget: 260 })
  assert.equal(msgs[0].role, 'system')
  assert.match(msgs[0].content, /ONLY the numbered sources/)
  const user = msgs.at(-1).content
  assert.match(user, /\[1\] \(resume\.pdf, page 1\)/)
  assert.ok(!user.includes('[3]'), 'third source dropped by the budget')
})

test('extractive fallback cites the sentence it used', () => {
  const passages = corpus.slice(0, 2).map((chunk) => ({ chunk }))
  assert.match(extractiveAnswer('What datasets were built at Addverb?', passages), /teleoperated robot-manipulation datasets.*\[1\]/)
  assert.equal(extractiveAnswer('favourite colour', passages), "I couldn't find that in the documents.")
  assert.deepEqual(citedSources('Built datasets [1][3]. Also [1].'), [1, 3])
})

test('sentence split keeps URLs, emails and decimals whole', () => {
  assert.deepEqual(splitSentences('Email hi@x.com or see github.com/sangamyo. CGPA is 7.8 overall. Done!'), ['Email hi@x.com or see github.com/sangamyo.', 'CGPA is 7.8 overall.', 'Done!'])
})

test('extractive answer prefers rare question words over common ones', () => {
  const chunks = [
    { id: 0, doc: 'r.pdf', page: 1, text: 'Hari Om Kasaundhan, AI engineer. Hari Om lives in Noida and likes Python.' },
    { id: 1, doc: 'r.pdf', page: 1, text: 'At Addverb, Hari Om built teleoperated datasets for VLA models.' },
    { id: 2, doc: 'r.pdf', page: 1, text: 'Hari Om studied at G L Bajaj.' },
  ]
  const bm25 = buildBM25(chunks)
  const answer = extractiveAnswer('What did Hari Om build at Addverb?', chunks.map((chunk) => ({ chunk })), { idf: bm25.idf, maxSentences: 1 })
  assert.match(answer, /^At Addverb/)
})

test('model output is cleaned and grounding is measured', () => {
  assert.equal(cleanAnswer('5 (resume.pdf, page 1) Built a MERN platform [5].'), 'Built a MERN platform [5].')
  const passages = [{ chunk: { text: 'Built a MERN platform serving 500+ active users with MongoDB.' } }]
  assert.ok(support('He built a MERN platform with MongoDB [1].', passages) >= 0.6)
  assert.ok(support('His favourite movie is The Big Lebowski starring John Travolta [1].', passages) < 0.3)
})

test('near-duplicate chunks are returned once', () => {
  const chunks = [
    { id: 0, doc: 'a', page: null, text: 'pgvector HNSW index gives 6 ms top-25 queries on the dolly dataset.' },
    { id: 1, doc: 'a', page: null, text: 'pgvector HNSW index gives 6 ms top-25 queries on the dolly dataset!' },
    { id: 2, doc: 'b', page: null, text: 'Redis and arq run the import jobs.' },
  ]
  const hits = hybridSearch({ query: 'pgvector query speed', queryVec: null, chunks, vectors: [], bm25: buildBM25(chunks) })
  assert.equal(hits.filter((h) => h.chunk.text.startsWith('pgvector')).length, 1)
})

test('pdf items become lines and paragraphs; ligature pieces stay joined', () => {
  const item = (str, x, y, width, h = 10) => ({ str, transform: [h, 0, 0, h, x, y], width })
  const text = pageText([
    item('EXPERIENCE', 50, 700, 80),
    item('Built a density-based adaptive tra', 50, 670, 170),
    item('ffi', 220.5, 670, 9),
    item('c simulation that', 229.6, 670, 90),
    item('wraps onto a second line.', 50, 656, 120),
  ])
  assert.equal(text, 'EXPERIENCE\nBuilt a density-based adaptive traffic simulation that wraps onto a second line.')
  assert.equal(stripMarkdown('# Title\n\n[link](https://x.y) and **bold** `code`'), 'Title\n\nlink and bold code')
})

test('uncited sentences get the passage they come from', async () => {
  const { attachCitations } = await import('./rag.js')
  const passages = [{ chunk: { text: 'B.Tech in Computer Science at G L Bajaj Institute, CGPA 7.8/10.' } }, { chunk: { text: 'Built a MERN platform for PureWashr.' } }]
  assert.equal(attachCitations('He studied Computer Science at G L Bajaj with a CGPA of 7.8. He also likes tea.', passages), 'He studied Computer Science at G L Bajaj with a CGPA of 7.8 [1]. He also likes tea.')
})

test('quick answers look past the question subject and into long list lines', async () => {
  const { questionSubject } = await import('./rag.js')
  assert.equal(questionSubject('What did Hari Om build at Addverb?'), 'Hari Om')
  assert.equal(questionSubject('Where did he study?'), '')
  const chunks = [
    { id: 0, doc: 'r', page: 1, text: 'Built by Hari Om Kasaundhan.' },
    { id: 1, doc: 'r', page: 1, text: 'Robotics & AI Intern — Addverb Technologies, Noida. Built teleoperated robot-manipulation datasets used to train VLA models.' },
    { id: 2, doc: 'r', page: 1, text: 'SKILLS Languages: Python, SQL, Java, JavaScript, TypeScript, Bash Backend: FastAPI, Django, Node.js, Express, REST APIs Databases: PostgreSQL, pgvector, Redis, MongoDB Frontend: React, Next.js, Tailwind CSS Tools: Docker, Linux, Git EDUCATION B.Tech, Computer Science (lateral entry) — CGPA: 7.8/10 2023 – 2026' },
  ]
  const bm25 = buildBM25(chunks)
  const ask = (q) => extractiveAnswer(q, chunks.map((chunk) => ({ chunk })), { idf: bm25.idf, maxSentences: 1 })
  assert.match(ask('What did Hari Om build at Addverb?'), /Addverb/)
  assert.match(ask('What databases has he worked with?'), /Databases: PostgreSQL, pgvector, Redis, MongoDB/)
  assert.match(ask('What was his CGPA?'), /CGPA: 7\.8\/10/)
})

test('system prompt carries no example facts a model could copy', async () => {
  const { SYSTEM_PROMPT } = await import('./rag.js')
  assert.doesNotMatch(SYSTEM_PROMPT, /MERN|Vercel|500\+|platform/i)
  assert.match(SYSTEM_PROMPT, /<fact from a source> \[n\]/)
})
