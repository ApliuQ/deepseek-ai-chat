import { resizeUploadImage } from '../../utils/resizeUploadImage.js'

export type OpenaiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export type LocalFile = { blob: Blob; name: string; isImage: boolean; mimeType?: string }
export type LocalFileLoader = (id: string) => Promise<LocalFile | undefined>

const dataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

const officeText = async (blob: Blob, extension: string): Promise<string> => {
  const { unzipSync, strFromU8 } = await import('fflate')
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
    filter: (file) =>
      extension === 'docx'
        ? file.name === 'word/document.xml'
        : /^ppt\/slides\/slide\d+\.xml$/.test(file.name),
  })
  return Object.keys(files)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => {
      const xml = new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml')
      if (xml.getElementsByTagName('parsererror').length) {
        throw new Error('Invalid Office document')
      }
      return Array.from(xml.getElementsByTagNameNS('*', 't'))
        .map((node) => node.textContent ?? '')
        .join('\n')
    })
    .join('\n')
}

const pdfText = async (blob: Blob, signal: AbortSignal): Promise<string> => {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href
  signal.throwIfAborted()
  const task = pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    isEvalSupported: false,
  })
  const abort = () => {
    void task.destroy()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const pdf = await task.promise
    const pages: string[] = []
    for (let page = 1; page <= pdf.numPages; page++) {
      signal.throwIfAborted()
      const content = await (await pdf.getPage(page)).getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return pages.join('\n')
  } finally {
    signal.removeEventListener('abort', abort)
    await task.destroy()
  }
}

export const toOpenaiFileParts = async (
  { blob, name, isImage, mimeType }: LocalFile,
  signal: AbortSignal
): Promise<OpenaiPart[]> => {
  signal.throwIfAborted()
  if (isImage) {
    const extension = name.split('.').at(-1)?.toLowerCase() ?? 'png'
    const type =
      blob.type ||
      mimeType ||
      `image/${extension === 'jpg' ? 'jpeg' : extension === 'svg' ? 'svg+xml' : extension}`
    const image = await resizeUploadImage(new File([blob], name, { type }), signal)
    return [{ type: 'image_url', image_url: { url: await dataUrl(image) } }]
  }
  const extension = name.split('.').at(-1)?.toLowerCase()
  let text = ''
  try {
    if (extension === 'docx' || extension === 'pptx') {
      text = await officeText(blob, extension)
    } else if (extension === 'pdf') {
      text = await pdfText(blob, signal)
    } else if (extension !== 'doc' && extension !== 'ppt') {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer())
      if (text.includes('\0')) {
        text = ''
      }
    }
  } catch {
    signal.throwIfAborted()
  }
  signal.throwIfAborted()
  if (text.trim()) {
    const filename = name
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    return [{ type: 'text', text: `<file name="${filename}">\n${text}\n</file>` }]
  }
  return [{ type: 'file', file: { filename: name, file_data: await dataUrl(blob) } }]
}
