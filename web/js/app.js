import { readFile } from './ingest.js'
import { NOT_FOUND, attachCitations, buildBM25, buildMessages, chunkPages, citedSources, cleanAnswer, extractiveAnswer, hybridSearch, retrievalQuery, support, tokenize } from './rag.js'

const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js'
const SAMPLE = {
  files: [
    'Hari_Om_Kasaundhan_Resume.pdf',
    'DataLens-README.md',
    'SYNCRONET-AI-README.md',
    'Hand-Gesture-Control-README.md',
    'Ghibli-Image-Converter-README.md',
    'Jarvis-AI-Assistant-README.md',
  ],
  questions: [
    'What did Hari Om build at Addverb?',
    'Which project uses pgvector, and how fast is its search?',
    'How does SYNCRONET-AI decide how long a light stays green?',
    'Where did he study, and what was his CGPA?',
    'How does the Ghibli converter run in the browser?',
    'What databases has he worked with?',
  ],
}

const $ = (id) => document.getElementById(id)
const chatEl = $('chat')
const questionEl = $('question')
const modelSelect = $('modelSelect')
const store = (() => {
  try {
    localStorage.setItem('rag-probe', '1')
    return localStorage
  } catch {
    const m = new Map()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }
  }
})()

const state = {
  docs: [], // { name, kind, status, pages, chunks: [], vectors: [], error }
  chunks: [],
  vectors: [],
  bm25: buildBM25([]),
  history: [],
  engine: null,
  engineModel: null,
  engineLoading: null,
  gpu: false,
  busy: false,
  sample: false,
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false))
  return n
}
const scrollChat = () => requestAnimationFrame(() => (chatEl.scrollTop = chatEl.scrollHeight))

/* ------------------------------------------------------------------ */
/* Embedding worker                                                    */
/* ------------------------------------------------------------------ */
const embedWorker = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
let reqId = 0
let embedReady = false
embedWorker.onmessage = ({ data }) => {
  if (data.type === 'load') {
    if (!embedReady) setIndexStat(`downloading embedding model… ${Math.round(data.progress ?? 0)}%`)
    return
  }
  const job = pending.get(data.id)
  if (!job) return
  if (data.type === 'step') job.onStep?.(data.done, data.total)
  else if (data.type === 'result') {
    embedReady = true
    pending.delete(data.id)
    job.resolve(data.vectors)
  } else if (data.type === 'error') {
    pending.delete(data.id)
    job.reject(new Error(data.message))
  }
}
function embed(texts, { query = false, onStep } = {}) {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onStep })
    embedWorker.postMessage({ id, texts, query })
  })
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */
function setIndexStat(text) {
  $('indexStat').textContent = text
}
function rebuildIndex() {
  const ready = state.docs.filter((d) => d.status === 'ready')
  state.chunks = []
  state.vectors = []
  for (const d of ready) {
    d.chunks.forEach((c, i) => {
      state.chunks.push({ ...c, id: state.chunks.length })
      state.vectors.push(d.vectors[i])
    })
  }
  state.bm25 = buildBM25(state.chunks)
  setIndexStat(state.chunks.length ? `${state.chunks.length} passages · ${ready.length} doc${ready.length === 1 ? '' : 's'}` : 'empty')
}

function renderDocs() {
  const list = $('docs')
  list.replaceChildren(
    ...state.docs.map((d, i) => {
      const kind = d.name.toLowerCase().endsWith('.pdf') ? 'pdf' : /\.(md|markdown)$/i.test(d.name) ? 'md' : 'txt'
      const meta =
        d.status === 'ready'
          ? el('span', { className: 'meta', textContent: `${d.pages.length > 1 || d.pages[0]?.page ? `${d.pages.length} page${d.pages.length > 1 ? 's' : ''} · ` : ''}${d.chunks.length} passages` })
          : el('span', { className: 'state', textContent: d.status === 'error' ? d.error : d.statusText || d.status })
      const remove = el('button', { type: 'button', className: 'remove', textContent: '×', title: `Remove ${d.name}` })
      remove.setAttribute('aria-label', `Remove ${d.name}`)
      remove.onclick = () => {
        state.docs.splice(i, 1)
        rebuildIndex()
        renderDocs()
        if (!state.docs.length) showWelcome()
      }
      return el('li', { className: 'doc' }, el('span', { className: `icon ${kind}`, textContent: kind.toUpperCase() }), el('div', {}, el('div', { className: 'name', textContent: d.name, title: d.name }), meta), remove)
    }),
  )
}

async function addFiles(files) {
  for (const file of files) {
    if (state.docs.some((d) => d.name === file.name)) continue
    const doc = { name: file.name, status: 'reading', statusText: 'reading…', pages: [], chunks: [], vectors: [] }
    state.docs.push(doc)
    renderDocs()
    try {
      doc.pages = await readFile(file, (p) => {
        doc.statusText = `reading… ${Math.round(p * 100)}%`
        renderDocs()
      })
      doc.chunks = chunkPages(doc.pages)
      if (!doc.chunks.length) throw new Error('no text found')
      doc.status = 'embedding'
      doc.statusText = 'embedding…'
      renderDocs()
      doc.vectors = await embed(
        doc.chunks.map((c) => c.text),
        {
          onStep: (done, total) => {
            doc.statusText = `embedding ${done}/${total}`
            renderDocs()
          },
        },
      )
      doc.status = 'ready'
    } catch (e) {
      doc.status = 'error'
      doc.error = e.message.slice(0, 90)
    }
    rebuildIndex()
    renderDocs()
  }
}

async function loadSample() {
  state.sample = true
  showWelcome()
  const files = await Promise.all(
    SAMPLE.files.map(async (name) => {
      const blob = await fetch(`samples/${name}`).then((r) => {
        if (!r.ok) throw new Error(`could not load ${name}`)
        return r.blob()
      })
      return new File([blob], name, { type: name.endsWith('.pdf') ? 'application/pdf' : 'text/markdown' })
    }),
  )
  await addFiles(files)
}

const drop = $('drop')
$('fileInput').addEventListener('change', (e) => {
  addFiles([...e.target.files])
  e.target.value = ''
})
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  addFiles([...e.dataTransfer.files])
})
$('loadSample').onclick = () => loadSample()
$('clearLib').onclick = () => {
  state.docs = []
  state.sample = false
  rebuildIndex()
  renderDocs()
  showWelcome()
}

/* ------------------------------------------------------------------ */
/* Sources panel                                                       */
/* ------------------------------------------------------------------ */
function highlight(text, terms) {
  const frag = document.createDocumentFragment()
  const re = /[A-Za-z0-9][A-Za-z0-9.+#-]*/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    const [tok] = tokenize(m[0])
    if (tok && terms.has(tok)) {
      frag.append(text.slice(last, m.index), el('mark', { textContent: m[0] }))
      last = m.index + m[0].length
    }
  }
  frag.append(text.slice(last))
  return frag
}

function renderSources(hits, question, used = null) {
  const terms = new Set(tokenize(question))
  $('srcStat').textContent = hits.length ? `${hits.length} passage${hits.length > 1 ? 's' : ''}` : 'no match'
  if (!hits.length) {
    $('sourceList').replaceChildren(el('p', { className: 'muted empty', textContent: 'Nothing in the library matched this question.' }))
    return
  }
  $('sourceList').replaceChildren(
    ...hits.map((h, i) => {
      const where = h.chunk.page ? `${h.chunk.doc} · p.${h.chunk.page}` : h.chunk.doc
      const card = el(
        'article',
        { className: `src ${used && !used.includes(i + 1) ? 'unused' : ''}`, id: `src-${i + 1}` },
        el(
          'div',
          { className: 'src-head' },
          el('span', { className: 'n', textContent: `[${i + 1}]` }),
          el('span', { className: 'where', textContent: where, title: where }),
          el('span', { className: 'badges' }, ...h.via.map((v) => el('span', { className: `badge ${v}`, textContent: v === 'vector' ? 'meaning' : 'keyword' }))),
        ),
        el('p', {}, highlight(h.chunk.text, terms)),
        el('div', {
          className: 'score',
          textContent: [h.vectorScore !== undefined && `cosine ${h.vectorScore.toFixed(2)}`, h.keywordScore !== undefined && `bm25 ${h.keywordScore.toFixed(1)}`, `rrf ${h.score.toFixed(3)}`].filter(Boolean).join(' · '),
        }),
      )
      card.onclick = () => card.classList.toggle('on')
      return card
    }),
  )
}

function focusSource(n, hits, question, used) {
  renderSources(hits, question, used)
  const card = $(`src-${n}`)
  if (!card) return
  card.classList.add('on')
  setTab('sources', { onlyIfNarrow: true })
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/* ------------------------------------------------------------------ */
/* Chat rendering                                                      */
/* ------------------------------------------------------------------ */
function showWelcome() {
  const hasSample = state.sample
  const suggest = el(
    'div',
    { className: 'suggest' },
    ...(hasSample ? SAMPLE.questions : []).map((q) => {
      const b = el('button', { type: 'button', textContent: q })
      b.onclick = () => ask(q)
      return b
    }),
  )
  chatEl.replaceChildren(
    el(
      'div',
      { className: 'welcome' },
      el('h1', {}, 'Ask questions about ', el('em', { textContent: 'your documents' })),
      el('p', {
        textContent: hasSample
          ? "The sample library has Hari Om's résumé and the READMEs of his projects. Try a question below, or drop in your own PDFs and notes."
          : 'Add PDFs, Markdown or text files on the left. Everything is processed in your browser, so nothing is uploaded.',
      }),
      suggest,
    ),
  )
  state.history = []
}

function addUser(text) {
  chatEl.querySelector('.welcome')?.remove()
  chatEl.append(el('div', { className: 'msg user' }, el('div', { className: 'bubble', textContent: text })))
  scrollChat()
}

/** Render answer text with clickable [n] citation chips. Only numbers that exist become chips. */
function renderAnswer(bubble, text, hits, question) {
  const parts = text.split(/(\[\d{1,2}\])/g)
  const used = citedSources(text).filter((n) => n <= hits.length)
  bubble.replaceChildren(
    ...parts.map((p) => {
      const m = p.match(/^\[(\d{1,2})\]$/)
      if (!m) return document.createTextNode(p)
      const n = Number(m[1])
      if (n > hits.length || n < 1) return document.createTextNode('')
      const b = el('button', { type: 'button', className: 'cite', textContent: n, title: hits[n - 1].chunk.doc })
      b.onclick = () => focusSource(n, hits, question, used)
      return b
    }),
  )
  return used
}

function addBot() {
  const bubble = el('div', { className: 'bubble' })
  const meta = el('div', { className: 'meta-row' })
  const extra = el('div')
  const msg = el('div', { className: 'msg bot' }, bubble, meta, extra)
  chatEl.append(msg)
  scrollChat()
  return { msg, bubble, meta, extra }
}

function status(container, text, progress = null) {
  container.replaceChildren(
    el('div', { className: 'status-line' }, el('span', { className: 'spinner' }), el('span', { textContent: text })),
    progress !== null ? el('div', { className: 'progress' }, el('i', { style: `width:${Math.round(progress * 100)}%` })) : null,
  )
}

/* ------------------------------------------------------------------ */
/* LLM                                                                 */
/* ------------------------------------------------------------------ */
let webllm = null
async function modelCached(model) {
  try {
    webllm ??= await import(WEBLLM)
    return await webllm.hasModelInCache(model)
  } catch {
    return false
  }
}

async function ensureEngine(onProgress) {
  const model = modelSelect.value
  if (state.engine && state.engineModel === model) return state.engine
  if (state.engineLoading && state.engineLoading.model === model) return state.engineLoading.promise
  const promise = (async () => {
    webllm ??= await import(WEBLLM)
    if (state.engine) await state.engine.unload().catch(() => {})
    const worker = new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' })
    const engine = await webllm.CreateWebWorkerMLCEngine(worker, model, {
      initProgressCallback: (r) => onProgress?.(r.progress, r.text),
    })
    state.engine = engine
    state.engineModel = model
    store.setItem('rag-ai', '1')
    return engine
  })()
  state.engineLoading = { model, promise }
  try {
    return await promise
  } finally {
    state.engineLoading = null
  }
}

const modelLabel = () => modelSelect.selectedOptions[0].textContent.split('·').slice(0, 2).join('·').trim()

/** Turn engine errors into something a visitor can act on. */
function explainError(e) {
  const msg = String(e?.message ?? e)
  if (e?.name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return `Your browser doesn't have room to store this model. Private windows have small storage limits, so try a normal window or the Fast model (290 MB).`
  }
  if (/out of memory|OOM|device lost|GPUDevice/i.test(msg)) return 'Your GPU ran out of memory for this model. Try the Fast model, which needs much less.'
  return `Couldn't run the model: ${msg}. Quick answers still work.`
}

async function generate(question, hits, view) {
  const t0 = performance.now()
  status(view.bubble, `Loading ${modelLabel()}…`, 0)
  const engine = await ensureEngine((p, text) => {
    const pct = Math.round(p * 100)
    status(view.bubble, /fetch|download/i.test(text) ? `Downloading ${modelLabel()} (one time) · ${pct}%` : `Preparing the model on your GPU · ${pct}%`, p)
    scrollChat()
  })
  const messages = buildMessages(question, hits, state.history)
  view.bubble.textContent = ''
  view.bubble.classList.add('streaming')
  let text = ''
  const tGen = performance.now()
  const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.1, top_p: 0.9, max_tokens: 450 })
  for await (const part of stream) {
    text += part.choices[0]?.delta?.content ?? ''
    renderAnswer(view.bubble, text, hits, question)
    scrollChat()
  }
  view.bubble.classList.remove('streaming')
  text = cleanAnswer(text) || NOT_FOUND
  const secs = ((performance.now() - tGen) / 1000).toFixed(1)
  // grounding check: if the answer's words aren't in the sources, don't show it as fact
  const grounded = text.startsWith("I couldn't find") || support(text, hits) >= 0.6
  if (!grounded) {
    console.warn('answer withheld, support', support(text, hits).toFixed(2), text)
    text = quickAnswer(question, hits, view)
    view.meta.replaceChildren(
      el('span', { className: 'tag quick', textContent: 'Quick answer' }),
      el('span', { textContent: `${modelLabel()} wrote something the sources don't support, so it was withheld` }),
    )
    return text
  }
  text = attachCitations(text, hits)
  const used = renderAnswer(view.bubble, text, hits, question)
  view.meta.replaceChildren(el('span', { className: 'tag ai', textContent: modelLabel() }), el('span', { textContent: `${secs}s · ${used.length ? `cites ${used.map((n) => `[${n}]`).join('')}` : 'no citations'}` }))
  renderSources(hits, question, used)
  console.debug('answer in', ((performance.now() - t0) / 1000).toFixed(1), 's')
  return text
}

function quickAnswer(question, hits, view) {
  const text = extractiveAnswer(question, hits, { idf: state.bm25.idf })
  const used = renderAnswer(view.bubble, text, hits, question)
  view.meta.replaceChildren(el('span', { className: 'tag quick', textContent: 'Quick answer' }), el('span', { textContent: 'best-matching sentences, no AI' }))
  renderSources(hits, question, used)
  return text
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */
async function ask(raw) {
  const question = raw.trim()
  if (!question || state.busy) return
  if (!state.chunks.length) {
    addUser(question)
    const v = addBot()
    v.bubble.textContent = state.docs.some((d) => d.status !== 'ready' && d.status !== 'error')
      ? 'Still reading your documents. Give it a few seconds and ask again.'
      : 'Add a document first, or load the sample library on the left.'
    return
  }
  state.busy = true
  $('composer').querySelector('.send').disabled = true
  addUser(question)
  const view = addBot()
  status(view.bubble, 'Searching your documents…')
  try {
    // finish indexing documents that are still being read before answering
    for (let i = 0; i < 240 && state.docs.some((d) => d.status === 'reading' || d.status === 'embedding'); i++) {
      status(view.bubble, 'Still indexing your documents…')
      await new Promise((r) => setTimeout(r, 250))
    }
    const rq = retrievalQuery(question, state.history)
    const [qvec] = await embed([rq], { query: true })
    const hits = hybridSearch({ query: rq, queryVec: qvec, chunks: state.chunks, vectors: state.vectors, bm25: state.bm25, topK: 5 })
    renderSources(hits, question)
    let answer
    if (!hits.length) {
      answer = "I couldn't find anything about that in your documents."
      view.bubble.textContent = answer
      view.meta.replaceChildren(el('span', { className: 'tag', textContent: 'no matching passages' }))
    } else if (state.gpu && (state.engine || store.getItem('rag-ai') === '1' || (await modelCached(modelSelect.value)))) {
      answer = await generate(question, hits, view)
    } else {
      answer = quickAnswer(question, hits, view)
      if (state.gpu) offerUpgrade(question, hits, view)
      else view.extra.replaceChildren(el('p', { className: 'muted', textContent: 'Written AI answers need WebGPU (recent Chrome or Edge on desktop). Quick answers work everywhere.' }))
    }
    state.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer })
  } catch (e) {
    console.error(e)
    view.bubble.classList.remove('streaming')
    view.bubble.textContent = explainError(e)
  } finally {
    state.busy = false
    $('composer').querySelector('.send').disabled = false
    scrollChat()
  }
}

function offerUpgrade(question, hits, view) {
  const size = modelSelect.selectedOptions[0].textContent.split('·').pop().trim()
  const load = el('button', { type: 'button', className: 'btn', textContent: `Write answers with AI (${size}, one-time download)` })
  const later = el('button', { type: 'button', className: 'btn ghost', textContent: 'Keep quick answers' })
  const box = el(
    'div',
    { className: 'upgrade' },
    el('span', { textContent: 'This was a quick answer made from the best-matching sentences. Load a small language model that runs on your GPU to get written answers with citations. Nothing leaves your device.' }),
    el('div', { className: 'row' }, load, later),
  )
  later.onclick = () => box.remove()
  load.onclick = async () => {
    box.remove()
    if (state.busy) return
    state.busy = true
    try {
      const answer = await generate(question, hits, view)
      const last = state.history.at(-1)
      if (last?.role === 'assistant') last.content = answer
    } catch (e) {
      console.error('model load failed', e)
      view.bubble.textContent = explainError(e)
    } finally {
      state.busy = false
    }
  }
  view.extra.replaceChildren(box)
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
$('composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const q = questionEl.value
  questionEl.value = ''
  autosize()
  ask(q)
})
questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
const autosize = () => {
  questionEl.style.height = 'auto'
  questionEl.style.height = `${Math.min(160, questionEl.scrollHeight)}px`
}
questionEl.addEventListener('input', autosize)

modelSelect.value = store.getItem('rag-model') || modelSelect.value
modelSelect.addEventListener('change', () => store.setItem('rag-model', modelSelect.value))

function setTab(tab, { onlyIfNarrow = false } = {}) {
  if (onlyIfNarrow && innerWidth > 1100) return
  document.querySelector('.layout').dataset.tab = tab
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === tab)))
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)))

;(async () => {
  const pill = $('gpuPill')
  try {
    state.gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter()))
  } catch {
    state.gpu = false
  }
  pill.textContent = state.gpu ? 'WebGPU ✓' : 'no WebGPU · quick answers'
  pill.className = `pill ${state.gpu ? 'ok' : 'warn'}`
})()

if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __rag: state, __embed: embed, __hybridSearch: hybridSearch })

showWelcome()
loadSample().catch((e) => setIndexStat(`sample failed: ${e.message}`))
