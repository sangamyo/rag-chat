/* Turn files into pages of text: PDF (via pdf.js, one entry per page), Markdown and plain text. */

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build'
let pdfjs = null

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}/pdf.min.mjs`)
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`
  }
  return pdfjs
}

/**
 * Rebuild lines and paragraphs from pdf.js text items using their positions:
 * a new line when y changes, a paragraph only when the vertical gap is clearly larger than a line,
 * and a space only when there is a real horizontal gap (so ligatures like "ffi" don't split words).
 */
export function pageText(items) {
  let out = ''
  let lastY = null
  let lastEndX = null
  let lastH = 10
  let lineGap = null
  for (const it of items) {
    if (!('str' in it) || it.str === '') continue
    const x = it.transform[4]
    const y = it.transform[5]
    const h = Math.abs(it.transform[3]) || lastH
    if (lastY !== null) {
      const dy = Math.abs(lastY - y)
      if (dy > h * 0.5) {
        // first line gap seen sets the baseline spacing for this page
        lineGap = lineGap === null ? dy : Math.min(lineGap, dy)
        out = out.replace(/[ \t]+$/, '')
        out += dy > Math.max(lineGap * 1.45, h * 1.9) ? '\n\n' : '\n'
      } else if (lastEndX !== null && x - lastEndX > h * 0.18 && !out.endsWith(' ') && !it.str.startsWith(' ')) {
        out += ' '
      }
    }
    out += it.str
    lastY = y
    lastH = h
    lastEndX = x + (it.width || 0)
  }
  // join lines that are just wrapped sentences; keep bullets, headings and list rows on their own line
  return out
    .split('\n\n')
    .map((para) =>
      para
        .split('\n')
        .reduce((acc, line) => {
          const t = line.trim()
          if (!acc.length) return [t]
          const prev = acc[acc.length - 1]
          const newItem = /^([•\-–*·▪●]|\d+[.)]\s|[A-Z][A-Z &/]{3,}$)/.test(t) || /^[A-Z][A-Z &/]{3,}$/.test(prev) || /[:.!?]$/.test(prev) && /^[A-Z]/.test(t) && t.length < 60
          if (newItem) acc.push(t)
          // a line ending in "-" is usually a compound word ("traffic-signal"), so keep the hyphen and join tightly
          else acc[acc.length - 1] = prev.endsWith('-') ? prev + t : `${prev} ${t}`
          return acc
        }, [])
        .join('\n'),
    )
    .join('\n\n')
}

/** @returns {Promise<{doc: string, page: number|null, text: string}[]>} */
export async function readFile(file, onProgress = () => {}) {
  const name = file.name
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
    const lib = await loadPdfjs()
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const pages = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      pages.push({ doc: name, page: n, text: pageText(content.items) })
      onProgress(n / pdf.numPages)
    }
    if (!pages.some((p) => p.text.trim())) throw new Error(`${name} has no selectable text (is it a scanned image?)`)
    return pages
  }
  if (/\.(md|markdown|txt|text|csv|json|html?)$/i.test(name) || file.type.startsWith('text/')) {
    let text = await file.text()
    if (/\.html?$/i.test(name)) text = new DOMParser().parseFromString(text, 'text/html').body.innerText
    if (/\.(md|markdown)$/i.test(name)) text = stripMarkdown(text)
    return [{ doc: name, page: null, text }]
  }
  throw new Error(`${name}: only PDF, Markdown and text files are supported`)
}

/** Keep the words, drop the syntax: links, images, HTML tags, code fences, table pipes. */
export function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ''))
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\|/g, ' · ')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
}
