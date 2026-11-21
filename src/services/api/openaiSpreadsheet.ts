import { unzip, strFromU8 } from 'fflate'

const MAX_EXPANDED = 16 * 1024 * 1024
const MAX_CELLS = 100000
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name))
const xml = (data: Uint8Array | undefined) => {
  if (!data) {
    throw new Error('工作簿缺少必要的 XML 文件')
  }
  const text = strFromU8(data)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error('工作簿包含不支持的 XML 声明')
  }
  const counts = { c: 0, si: 0, row: 0 }
  for (const match of text.matchAll(/<(?:[\w.-]+:)?(c|si|row)(?=[\s/>])/g)) {
    const tag = match[1] as keyof typeof counts
    if (++counts[tag] > MAX_CELLS) {
      throw new Error('工作簿超过 100000 个单元格安全上限')
    }
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('工作簿 XML 无效')
  }
  return doc
}

export const spreadsheetText = async (blob: Blob, signal: AbortSignal): Promise<string> => {
  if (blob.size > 8 * 1024 * 1024) {
    throw new Error('工作簿超过 8 MiB 安全上限')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal.throwIfAborted()
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let expanded = 0
    let entries = 0
    let exceeded = false
    const abort = () => {
      terminate()
      reject(signal.reason)
    }
    const terminate = unzip(
      bytes,
      {
        filter: (file) => {
          expanded += file.originalSize
          exceeded ||= expanded > MAX_EXPANDED || ++entries > 2048
          return (
            !exceeded &&
            /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
              file.name
            )
          )
        },
      },
      (error, result) => {
        signal.removeEventListener('abort', abort)
        if (error || exceeded) {
          reject(error ?? new Error('工作簿解压大小或文件数量超过安全上限'))
        } else {
          resolve(result)
        }
      }
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })
  signal.throwIfAborted()
  if (Object.values(files).reduce((sum, data) => sum + data.byteLength, 0) > MAX_EXPANDED) {
    throw new Error('工作簿解压大小超过安全上限')
  }
  const workbook = xml(files['xl/workbook.xml'])
  const relationships = elements(xml(files['xl/_rels/workbook.xml.rels']), 'Relationship')
  const strings = files['xl/sharedStrings.xml']
    ? elements(xml(files['xl/sharedStrings.xml']), 'si').map((si) =>
        elements(si, 't')
          .map((t) => t.textContent ?? '')
          .join('')
      )
    : []
  let cells = 0
  let length = 0
  const output: string[] = []
  const append = (line: string) => {
    output.push(line)
    length += line.length
  }
  for (const sheet of elements(workbook, 'sheet')) {
    signal.throwIfAborted()
    await pause()
    const id =
      sheet.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      ) ?? sheet.getAttribute('r:id')
    const relation = relationships.find((item) => item.getAttribute('Id') === id)
    if (!relation || relation.getAttribute('TargetMode') === 'External') {
      throw new Error('工作簿工作表关系无效')
    }
    const target = new URL(
      relation.getAttribute('Target') ?? '',
      'https://xlsx.invalid/xl/workbook.xml'
    )
    if (
      target.origin !== 'https://xlsx.invalid' ||
      !target.pathname.startsWith('/xl/worksheets/')
    ) {
      throw new Error('工作簿工作表路径无效')
    }
    const document = xml(files[target.pathname.slice(1)])
    const rows = elements(document, 'row')
    const count = elements(document, 'c').length
    cells += count
    if (cells > MAX_CELLS || rows.length > MAX_CELLS || strings.length > MAX_CELLS) {
      throw new Error('工作簿超过 100000 个单元格安全上限')
    }
    append(
      `# Sheet: ${sheet.getAttribute('name') ?? ''}\nRow\tCells (A1 positions; tabs preserve empty columns)`
    )
    for (let index = 0; index < rows.length; index++) {
      if (index % 200 === 0) {
        await pause()
        signal.throwIfAborted()
      }
      const values: string[] = []
      let rowNumber = ''
      for (const cell of elements(rows[index], 'c')) {
        const reference = cell.getAttribute('r') ?? ''
        const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference)
        if (!match || Number(match[2]) > 1048576) {
          throw new Error('工作簿单元格坐标无效')
        }
        let column = 0
        for (const char of match[1]) {
          column = column * 26 + char.charCodeAt(0) - 64
        }
        if (column > 16384 || (rowNumber && rowNumber !== match[2])) {
          throw new Error('工作簿单元格坐标无效')
        }
        rowNumber = match[2]
        const type = cell.getAttribute('t')
        const cached = elements(cell, 'v')[0]?.textContent ?? ''
        const value =
          type === 's'
            ? (strings[Number(cached)] ?? '')
            : type === 'inlineStr'
              ? elements(cell, 't')
                  .map((t) => t.textContent ?? '')
                  .join('')
              : cached
        values[column - 1] = `${reference}=${value.replace(/[\t\r\n]/g, ' ')}`
      }
      append(`${rowNumber || rows[index].getAttribute('r') || index + 1}\t${values.join('\t')}`)
      if (length > 1024 * 1024) {
        return `${output.join('\n')}\n[附件内容已截断：上限 1 MiB]`
      }
    }
  }
  return output.join('\n')
}
