import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { loadApi } from './testHarness.mjs'

const signal = () => new AbortController().signal
const workbook = (
  sheet = '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="inlineStr"><is><t>内联</t></is></c><c r="D2"><f>1+2</f><v>3</v></c></row>',
  extras = {}
) =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        'xl/workbook.xml':
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" r:id="a"/><sheet name="第二页" r:id="b"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':
          '<Relationships><Relationship Id="a" Target="worksheets/sheet1.xml"/><Relationship Id="b" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<sst><si><r><t>共享</t></r><r><t>文本</t></r></si></sst>',
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
        'xl/worksheets/sheet2.xml':
          '<worksheet><sheetData><row r="1"><c r="B1"><v>4821</v></c></row></sheetData></worksheet>',
        ...extras,
      }).map(([name, value]) => [name, strToU8(value)])
    )
  )

test('lazy XLSX extraction preserves sheets, shared/inline strings, cached formulas and sparse positions', async () => {
  const api = await loadApi()
  const [part] = await api.toOpenaiFileParts(
    { blob: new Blob([workbook()]), name: 'book.xlsx', isImage: false },
    signal()
  )
  assert.match(part.text, /file name="book.xlsx"/)
  assert.match(part.text, /# Sheet: 数据/)
  assert.match(part.text, /2\tA2=共享文本\t\tC2=内联\tD2=3/)
  assert.match(part.text, /# Sheet: 第二页[\s\S]*1\t\tB1=4821/)
})

test('CSV decodes UTF-8 then GB18030 and text output is capped at 1 MiB with filename/notice', async () => {
  const api = await loadApi()
  for (const [bytes, expected] of [
    [new TextEncoder().encode('姓名,金额\n张三,17'), '张三,17'],
    [new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31, 0x37]), '中文,17'],
  ]) {
    const [part] = await api.toOpenaiFileParts(
      { blob: new Blob([bytes]), name: 'test.csv', isImage: false },
      signal()
    )
    assert.match(part.text, new RegExp(expected))
  }
  const [large] = await api.toOpenaiFileParts(
    { blob: new Blob(['中'.repeat(600000)]), name: 'large.tsv', isImage: false },
    signal()
  )
  assert.ok(new TextEncoder().encode(large.text).length <= 1024 * 1024)
  assert.match(large.text, /large.tsv/)
  assert.match(large.text, /已截断/)
  assert.doesNotMatch(large.text, /�/)
})

test('unsupported, empty and malformed files send readable text and notify instead of base64', async () => {
  const api = await loadApi()
  for (const [name, blob] of [
    ['legacy.xls', new Blob(['binary'])],
    ['raw.bin', new Blob([new Uint8Array([0, 1, 2])])],
    ['binary.txt', new Blob([new Uint8Array([0, 1, 2])])],
    ['empty.csv', new Blob([])],
    ['bad.xlsx', new Blob(['bad zip'])],
  ]) {
    const notices = []
    const parts = await api.toOpenaiFileParts({ blob, name, isImage: false }, signal(), (text) =>
      notices.push(text)
    )
    assert.equal(parts[0].type, 'text')
    assert.match(parts[0].text, /无法提取内容/)
    assert.ok(parts[0].text.includes(name))
    assert.equal(notices.length, 1)
    if (name.endsWith('.xls')) {
      assert.match(parts[0].text, /请另存为 xlsx\/csv/)
    }
    assert.equal(parts[0].file, undefined)
  }
})

test('XLSX expanded-size, cell-count, invalid coordinates and cancellation guards', async () => {
  const api = await loadApi()
  for (const bytes of [
    workbook('', { 'unused.bin': 'x'.repeat(16 * 1024 * 1024 + 1) }),
    workbook('<row>' + '<c r="A1"><v>1</v></c>'.repeat(100001) + '</row>'),
    workbook('<row><c r="ZZZ1"><v>1</v></c></row>'),
  ]) {
    const [part] = await api.toOpenaiFileParts(
      { blob: new Blob([bytes]), name: 'bomb.xlsx', isImage: false },
      signal()
    )
    assert.match(part.text, /无法提取内容/)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    api.toOpenaiFileParts(
      { blob: new Blob([workbook()]), name: 'book.xlsx', isImage: false },
      controller.signal
    ),
    { name: 'AbortError' }
  )
})
