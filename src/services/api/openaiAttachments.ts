import { resizeUploadImage } from '../../utils/resizeUploadImage.js'

export type OpenaiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type LocalFile = { blob: Blob; name: string; isImage: boolean; mimeType?: string }
export type LocalFileLoader = (id: string) => Promise<LocalFile | undefined>

const hasBinaryControls = (text: string) => {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true
    }
  }
  return false
}

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
  signal: AbortSignal,
  onNotice: (message: string) => void = () => {}
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
  let failure = ''
  try {
    if (extension === 'docx' || extension === 'pptx') {
      text = await officeText(blob, extension)
    } else if (extension === 'pdf') {
      text = await pdfText(blob, signal)
    } else if (extension === 'xlsx') {
      text = await (await import('./openaiSpreadsheet.js')).spreadsheetText(blob, signal)
    } else if (extension !== 'xls' && extension !== 'doc' && extension !== 'ppt') {
      const bytes = new Uint8Array(await blob.slice(0, 4 * 1024 * 1024).arrayBuffer())
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
          stream: blob.size > bytes.byteLength,
        })
      } catch {
        text = new TextDecoder('gb18030', { fatal: true }).decode(bytes, {
          stream: blob.size > bytes.byteLength,
        })
      }
      if (hasBinaryControls(text)) {
        throw new Error('文件不是可读取的文本')
      }
      if (blob.size > bytes.byteLength) {
        text += '\n[附件内容已截断：上限 1 MiB]'
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    text = ''
    failure = error instanceof Error ? error.message : '文件解析失败'
  }
  signal.throwIfAborted()
  if (text.trim()) {
    const filename = name
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    const prefix = `<file name="${filename.slice(0, 1024)}">\n`
    const suffix = '\n</file>'
    const encoder = new TextEncoder()
    const bytes = encoder.encode(text)
    const limit = 1024 * 1024 - encoder.encode(prefix + suffix).byteLength
    if (bytes.byteLength > limit) {
      const notice = '\n[附件内容已截断：上限 1 MiB]'
      text =
        new TextDecoder().decode(bytes.subarray(0, limit - encoder.encode(notice).byteLength), {
          stream: true,
        }) + notice
    }
    return [{ type: 'text', text: `${prefix}${text}${suffix}` }]
  }
  const notice = `附件 ${name}（${mimeType || blob.type || extension || '未知类型'}，${blob.size} bytes）无法提取内容。${extension === 'xls' ? '请另存为 xlsx/csv。' : '请转换为文本或受支持的文档格式。'}${failure}`
  onNotice(notice)
  return [{ type: 'text', text: notice }]
}
