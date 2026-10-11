# RAG Chat: ask your documents

**▶ Live demo:** https://sangamyo.github.io/rag-chat/

Retrieval-augmented generation that runs **entirely in your browser**. Drop in PDFs, Markdown or text files and ask questions; answers come with numbered citations you can click to see the exact passage and page. There's no server, no API key, and your files never leave your device.

The demo opens with a sample library (my résumé and the READMEs of my projects), so you can ask things like *"What did Hari Om build at Addverb?"* straight away.

## How it works

```
files ──► text per page ──► chunks ──► embeddings ──┐
(pdf.js)                    (~900 chars,  (bge-small, │
                             overlap)     384-d)      ▼
question ──► embedding ──► vector search (cosine) ─┐
         └─────────────► keyword search (BM25) ────┴─► reciprocal rank fusion ─► top 5 passages
                                                                                   │
                       in-browser LLM (WebLLM, WebGPU) ◄── grounded prompt ◄───────┘
                                   │
                       answer ──► grounding check ──► citations ──► chat + sources panel
```

1. **Ingest:** PDFs are read page by page with pdf.js. Lines and paragraphs are rebuilt from text positions, so wrapped lines join and ligatures don't split words. Markdown is stripped to plain text.
2. **Chunk:** passages of about 900 characters follow paragraph and sentence boundaries and overlap by about 160 characters, so a fact on a boundary appears in both chunks. Over-long lines are split at word boundaries; no text is dropped.
3. **Embed:** `Xenova/bge-small-en-v1.5` (8-bit, about 34 MB) runs in a Web Worker with transformers.js. Queries get bge's retrieval instruction prefix.
4. **Retrieve (hybrid):** cosine similarity and BM25 run in parallel and are merged with reciprocal rank fusion. Weak meaning-only matches (cosine < 0.5, with no keyword overlap) are dropped, so off-topic questions return "not found" instead of a random passage. Near-duplicate chunks are removed.
5. **Generate:** the top passages go into a prompt that only allows answers from the sources, with `[n]` citations. The model runs on your GPU with WebLLM in a worker and streams token by token. You can choose Qwen2.5 0.5B (290 MB), Llama 3.2 1B (705 MB) or Qwen2.5 1.5B (880 MB). Each downloads once and is cached.
6. **Guard rails:**
   - **Grounding check:** if too few of the answer's words appear in the retrieved passages (support < 0.6), the answer is withheld and the quick answer is shown instead. This caught invented answers in testing, such as a "favourite movie" the documents never mention.
   - **Citation repair:** an uncited sentence gets the passage it overlaps most.
   - **Follow-ups:** a question like "what tools did he use there?" borrows the previous question for retrieval.
7. **Quick answers (no download):** until a model is loaded, or on browsers without WebGPU, extractive answers pick the best sentences by rare-word (IDF) weight. They ignore the question's subject (for example a person's name), so the actual question words decide.

## Tests

```sh
cd web && node --test
```

16 tests cover chunking, sentence splitting, BM25, fusion, the relevance cut-off, de-duplication, follow-up queries, prompt budgeting, quick answers, output clean-up, the grounding score, citation repair and PDF line reconstruction. They run on every push before the site deploys.

## Run locally

```sh
python -m http.server -d web 8000   # open http://localhost:8000
```

The LLM needs WebGPU (recent Chrome or Edge on desktop; Safari 26+). Private windows have small storage limits, so the larger models may not fit there.

## Limits

- Small models can still combine true facts from different passages into a wrong sentence. Word-level grounding can't catch every such mix-up, which is why every answer shows its sources.
- Scanned PDFs (images without a text layer) aren't supported; there's no OCR.
- The index lives in memory for the session.

## Stack

transformers.js 4.3 · WebLLM 0.2.85 · pdf.js 6.3 · vanilla JS modules · GitHub Pages. The sample documents are my own résumé and project READMEs.

Built by [Hari Om Kasaundhan](https://sangamyo.github.io/terminal/).
