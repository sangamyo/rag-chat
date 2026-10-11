/* Embeddings in a worker: bge-small-en-v1.5 (384-d, normalised) via transformers.js. */
import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js'

env.allowLocalModels = false
const MODEL = 'Xenova/bge-small-en-v1.5'
// bge recommends this instruction for queries (not for passages)
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
let extractor = null

async function load() {
  if (extractor) return extractor
  const progress = (p) => p.status === 'progress' && self.postMessage({ type: 'load', file: p.file, progress: p.progress })
  // the 8-bit model is ~34 MB and fast enough on the CPU for document-sized collections
  extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8', progress_callback: progress })
  return extractor
}

self.onmessage = async ({ data }) => {
  const { id, texts, query } = data
  try {
    const model = await load()
    const input = query ? texts.map((t) => QUERY_PREFIX + t) : texts
    const vectors = []
    for (let i = 0; i < input.length; i += 16) {
      const out = await model(input.slice(i, i + 16), { pooling: 'cls', normalize: true })
      vectors.push(...out.tolist())
      if (!query) self.postMessage({ type: 'step', id, done: Math.min(i + 16, input.length), total: input.length })
    }
    self.postMessage({ type: 'result', id, vectors })
  } catch (e) {
    self.postMessage({ type: 'error', id, message: String(e?.message || e) })
  }
}
