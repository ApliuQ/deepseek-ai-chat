import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { collect, loadApi, sseBody } from './testHarness.mjs'

const signal = () => new AbortController().signal
const file = (text, name = 'large.txt') => ({ blob: new Blob([text]), name, isImage: false })
const call = (args, name = 'read_file') => ({
  id: 'read',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})
const sse = (delta, finish = 'stop') =>
  new Response(
    sseBody(
      [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
        .map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n')
        .join('')
    ),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const answer = (events) => events.map((e) => e.content_block?.text ?? e.delta?.text ?? '').join('')
const book = () =>
  new Blob([
    zipSync(
      Object.fromEntries(
        Object.entries({
          'xl/workbook.xml':
            '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Audit" r:id="a"/></sheets></workbook>',
          'xl/_rels/workbook.xml.rels':
            '<Relationships><Relationship Id="a" Target="worksheets/sheet1.xml"/></Relationships>',
          'xl/worksheets/sheet1.xml':
            '<worksheet><sheetData>' +
            Array.from(
              { length: 2000 },
              (_, i) =>
                '<row r="' +
                (i + 1) +
                '"><c r="B' +
                (i + 1) +
                '" t="inlineStr"><is><t>' +
                (i === 1998 ? 'LATE-MARKER' : 'ordinary value') +
                '</t></is></c></row>'
            ).join('') +
            '</sheetData></worksheet>',
        }).map(([k, v]) => [k, strToU8(v)])
      )
    ),
  ])

test('text previews send only 10KB, small files stay whole, binaries expose metadata only', async () => {
  const api = await loadApi()
  for (const [text, truncated] of [
    ['small', false],
    ['中'.repeat(12000) + 'SECRET-TAIL', true],
  ]) {
    const [part] = await api.toOpenaiFileParts(file(text), signal(), undefined, 'local:file')
    const lines = part.text.split('\n'),
      info = JSON.parse(lines[1])
    assert.equal(info.name, 'large.txt')
    assert.equal(info.size, new Blob([text]).size)
    assert.equal(info.file_id, 'local:file')
    assert.equal(info.truncated, truncated)
    assert.ok(info.preview_bytes <= 10240)
    assert.doesNotMatch(part.text, /�/)
    if (truncated) {
      assert.doesNotMatch(part.text, /SECRET-TAIL/)
    } else {
      assert.match(part.text, /small/)
    }
  }
  for (const name of [
    'file.bin',
    'file.xls',
    'file.zip',
    'file.exe',
    'file.unknown',
    'empty.txt',
    'broken.docx',
  ]) {
    const [part] = await api.toOpenaiFileParts(
      file(name === 'empty.txt' ? '' : 'HIDDEN-BINARY-CONTENT', name),
      signal()
    )
    assert.deepEqual(Object.keys(JSON.parse(part.text)).sort(), ['name', 'size', 'type'])
    assert.doesNotMatch(part.text, /HIDDEN-BINARY-CONTENT/)
  }
})

test('read_file validates IDs, arguments, byte bounds, missing files, cancellation and total budget', async () => {
  const api = await loadApi()
  const read = api.createFileReader(new Set(['local:f']), async () =>
    file('x'.repeat(10240) + 'LATE-MARKER' + 'y'.repeat(400000))
  )
  assert.match(
    (await read(call({ file_id: 'local:f', offset: 10240, length: 16 }), signal())).content,
    /LATE-MARKER/
  )
  assert.equal(
    (await read(call({ file_id: 'local:f', offset: 999999, length: 10 }), signal())).content,
    ''
  )
  for (const args of [
    { file_id: 'unknown' },
    { file_id: 'local:f', offset: -1 },
    { file_id: 'local:f', length: 0 },
    { file_id: 'local:f', length: 16385 },
    { file_id: 'local:f', length: '10' },
    { file_id: 'local:f', extra: true },
    { file_id: 'local:f', offset: Infinity },
    { file_id: 'local:f', sheet: 'Audit', range: 'A1:B2' },
    null,
    [],
  ]) {
    await assert.rejects(read(call(args), signal()))
  }
  await assert.rejects(read(call({ file_id: 'local:f' }, 'unknown'), signal()))
  const missing = api.createFileReader(new Set(['local:f']), async () => undefined)
  await assert.rejects(missing(call({ file_id: 'local:f' }), signal()), /本地文件不可用/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(read(call({ file_id: 'local:f' }), controller.signal), {
    name: 'AbortError',
  })
  const budget = api.createFileReader(new Set(['local:f']), async () => file('x'.repeat(20000)))
  await assert.rejects(async () => {
    for (let i = 0; i < 24; i++) {
      await budget(call({ file_id: 'local:f', length: 16384 }), signal())
    }
  }, /256KB/)
  const unicode = api.createFileReader(new Set(['f']), async () => file('你好世界'))
  assert.doesNotMatch(
    (await unicode(call({ file_id: 'f', offset: 1, length: 8 }), signal())).content,
    /�/
  )
  const bounded = api.createFileReader(new Set(['f']), async () => file('small'))
  for (let i = 0; i < 24; i++) {
    await bounded(call({ file_id: 'f', offset: 99999, length: 1 }), signal())
  }
  await assert.rejects(bounded(call({ file_id: 'f' }), signal()), /24 次/)
})

test('spreadsheet metadata and strict late-cell reads survive a fresh loader', async () => {
  const api = await loadApi(),
    stored = { blob: book(), name: 'large.xlsx', isImage: false }
  const [part] = await api.toOpenaiFileParts(stored, signal(), undefined, 'local:f')
  assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(part.text.split('\n')[1]).sheets)), [
    { name: 'Audit', rows: 2000 },
  ])
  assert.doesNotMatch(part.text, /LATE-MARKER/)
  const read = api.createFileReader(new Set(['local:f']), async () => ({
    ...stored,
    blob: stored.blob.slice(),
  }))
  assert.match(
    (await read(call({ file_id: 'local:f', sheet: 'Audit', range: 'B1999' }), signal())).content,
    /B1999=LATE-MARKER/
  )
  assert.equal(
    (await read(call({ file_id: 'local:f', sheet: 'Audit', range: 'A1:A1' }), signal())).content,
    '1'
  )
  for (const args of [
    { sheet: 'Missing', range: 'A1:A1' },
    { sheet: 'Audit', range: 'A1:A101' },
    { sheet: 'Audit', range: 'Z2:A1' },
    { sheet: 'Audit', range: 'A0:A1' },
    { sheet: 'Audit', range: 'A1:ZZ1' },
    { sheet: 'Audit', range: 'A1:A2', offset: 0 },
  ]) {
    await assert.rejects(read(call({ file_id: 'local:f', ...args }), signal()))
  }
})

test('file and search calls share one history; file tools also work with search off', async () => {
  for (const search of [false, true]) {
    const calls = []
    const api = await loadApi({
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, body })
        if (url.includes('mcp.exa.ai')) {
          return Response.json({
            id: 1,
            result: {
              content: [
                {
                  type: 'text',
                  text: 'Title: source\nURL: https://example.com/\nHighlights:\nlatest fact',
                },
              ],
            },
          })
        }
        const results = body.messages.filter((m) => m.role === 'tool')
        if (results.length) {
          assert.match(results.find((m) => m.tool_call_id === 'read').content, /LATE-MARKER/)
          assert.equal(results.length, search ? 2 : 1)
          return sse({ content: 'LATE-MARKER found' })
        }
        assert.equal(
          body.tools.some((t) => t.function.name === 'web_search'),
          search
        )
        return sse(
          {
            tool_calls: [
              { index: 0, ...call({ file_id: 'local:f', offset: 12000, length: 40 }) },
              ...(search
                ? [{ index: 1, ...call({ query: 'latest fact' }, 'web_search'), id: 'search' }]
                : []),
            ],
          },
          'tool_calls'
        )
      },
    })
    const body = await api.buildOpenaiRequest(
      [{ role: 'user', content: [{ type: 'document', source: { file_id: 'local:f' } }] }],
      'model',
      false,
      search,
      async () => file('x'.repeat(12000) + 'LATE-MARKER'),
      signal()
    )
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
    )
    assert.match(answer(events), /读取文件 large.txt/)
    assert.match(answer(events), /LATE-MARKER found/)
    assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
    assert.equal(calls.filter((c) => c.url.includes('chat/completions')).length, 2)
  }
})

test('file errors return tool results, round limits terminate, and small files need no tool', async () => {
  let requests = 0
  const api = await loadApi({
    fetch: async (_url, init) => {
      requests++
      const body = JSON.parse(init.body)
      if (requests > 1) {
        assert.match(body.messages.filter((m) => m.role === 'tool').at(-1).content, /文件 ID/)
      }
      return sse({ tool_calls: [{ index: 0, ...call({ file_id: 'not-allowed' }) }] }, 'tool_calls')
    },
  })
  const messages = [
    { role: 'user', content: [{ type: 'document', source: { file_id: 'local:f' } }] },
  ]
  const body = await api.buildOpenaiRequest(
    messages,
    'model',
    false,
    false,
    async () => file('x'.repeat(12000)),
    signal()
  )
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
  )
  assert.equal(requests, 9)
  assert.match(answer(events), /8 轮/)
  const small = await api.buildOpenaiRequest(
    messages,
    'model',
    false,
    false,
    async () => file('small'),
    signal()
  )
  assert.equal(small.tools, undefined)
})

test('PDF renders at most 20 sane-resolution images, reports omissions and cleans up', async () => {
  let rendered = 0,
    destroyed = 0,
    cleaned = 0
  const api = await loadApi({
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
        toDataURL: () => 'data:image/jpeg;base64,aW1hZ2U=',
      }),
    },
    pdfjs: {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 23,
          getPage: async () => ({
            getViewport: ({ scale }) => ({ width: 1000 * scale, height: 2000 * scale }),
            render: ({ viewport }) => {
              assert.ok(viewport.height <= 1536)
              rendered++
              return { promise: Promise.resolve() }
            },
            cleanup: () => cleaned++,
          }),
        }),
        destroy: async () => destroyed++,
      }),
    },
  })
  const parts = await api.toOpenaiFileParts(file('pdf', 'pages.pdf'), signal())
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 20)
  assert.match(parts.at(-1).text, /已省略 3 页/)
  assert.equal(rendered, 20)
  assert.equal(cleaned, 20)
  assert.equal(destroyed, 1)
})

test('custom 50MB attachment rejection is separate from unchanged official limits', async () => {
  const api = await loadApi()
  const sized = (name, size) => {
    const f = new File([], name)
    Object.defineProperty(f, 'size', { value: size })
    return f
  }
  api.useSettings.setState({ baseUrl: 'https://custom.test' })
  assert.equal(api.validateFiles([sized('binary.exe', 50 * 1024 * 1024)], 0), null)
  assert.equal(
    api.validateFiles([sized('binary.exe', 50 * 1024 * 1024 + 1)], 0).key,
    'uploadCustomTooLarge'
  )
  assert.equal(api.validateFiles([sized('small.zip', 1)], 0), null)
  assert.equal(api.validateFiles([sized('small.txt', 1)], 50).key, 'uploadMaxFiles')
  api.useSettings.setState({ baseUrl: 'https://api.deepseek.com' })
  assert.equal(api.validateFiles([sized('binary.exe', 1)], 0).key, 'uploadUnsupportedFormat')
  assert.equal(api.validateFiles([sized('large.txt', 33 * 1024 * 1024)], 0).params.size, 32)
  assert.equal(api.validateFiles([sized('large.pdf', 65 * 1024 * 1024)], 0).params.size, 64)
})
