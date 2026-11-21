import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { collect, loadApi, sseBody } from './testHarness.mjs'

const signal = () => new AbortController().signal
const plain = (value) => JSON.parse(JSON.stringify(value))
const noFiles = async () => undefined
const body = (frames) =>
  frames
    .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    .join('')

test('maps reminder, assistant text, thinking, search and continuation without DeepSeek fields', async () => {
  const api = await loadApi()
  const request = await api.buildOpenaiRequest(
    [
      { role: 'latest_reminder', content: 'date,location,language' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: 'secret' },
          { type: 'server_tool_use', name: 'deepseek_read_url' },
          { type: 'text', text: 'partial' },
        ],
      },
    ],
    'custom-model',
    true,
    true,
    noFiles,
    signal()
  )
  assert.deepEqual(plain(request), {
    model: 'custom-model',
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'high',
    web_search_options: {},
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'date,location,language' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'partial' },
      {
        role: 'user',
        content: 'Continue your previous response from where it stopped. Do not repeat it.',
      },
    ],
  })
  const off = await api.buildOpenaiRequest([], 'custom-model', false, false, noFiles, signal())
  assert.equal(off.reasoning_effort, 'none')
  assert.equal('web_search_options' in off, false)
  assert.equal('tools' in off, false)
  await assert.rejects(
    api.buildOpenaiRequest([], '', false, false, noFiles, signal()),
    /Select a model/
  )
})

test('inlines images, UTF-8 and Office files, falls back for binary and missing local originals', async () => {
  const api = await loadApi()
  const files = {
    image: {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      name: 'x.png',
      isImage: true,
    },
    text: { blob: new Blob(['hello 世界']), name: 'x.py', isImage: false },
    docx: {
      blob: new Blob([
        zipSync({
          'word/document.xml': strToU8(
            '<w:document xmlns:w="word"><w:t>hello &amp; office</w:t></w:document>'
          ),
        }),
      ]),
      name: 'x.docx',
      isImage: false,
    },
    pptx: {
      blob: new Blob([
        zipSync({
          'ppt/slides/slide10.xml': strToU8('<a:p xmlns:a="draw"><a:t>ten</a:t></a:p>'),
          'ppt/slides/slide2.xml': strToU8('<a:p xmlns:a="draw"><a:t>two</a:t></a:p>'),
        }),
      ]),
      name: 'x.pptx',
      isImage: false,
    },
    legacy: { blob: new Blob(['binary']), name: 'x.doc', isImage: false },
  }
  const request = await api.buildOpenaiRequest(
    [
      {
        role: 'user',
        content: [
          ...Object.keys(files).map((id) => ({
            type: 'document',
            source: { type: 'file', file_id: id },
          })),
          { type: 'text', text: 'question' },
        ],
      },
    ],
    'model',
    false,
    false,
    async (id) => files[id],
    signal()
  )
  const parts = plain(request.messages[1].content)
  assert.deepEqual(parts[0], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AQID' },
  })
  assert.match(parts[1].text, /hello 世界/)
  assert.match(parts[2].text, /hello & office/)
  assert.match(parts[3].text, /two\nten/)
  assert.equal(parts[4].type, 'text')
  assert.match(parts[4].text, /x.doc.*无法提取内容/)
  const missing = await api.buildOpenaiRequest(
    [{ role: 'user', content: [{ type: 'image', source: { file_id: 'absent' } }] }],
    'model',
    false,
    false,
    noFiles,
    signal()
  )
  assert.equal(missing.messages[1].content, '[Attachment unavailable locally]')
  const inferredImage = await api.toOpenaiFileParts(
    { blob: new Blob(['image']), name: 'no-mime.png', isImage: true },
    signal()
  )
  assert.match(inferredImage[0].image_url.url, /^data:image\/png;base64,/)
  for (const file of [
    { blob: new Blob([]), name: 'empty.txt', isImage: false },
    { blob: new Blob(['not zip']), name: 'broken.docx', isImage: false },
  ]) {
    assert.match((await api.toOpenaiFileParts(file, signal()))[0].text, /无法提取内容/)
  }
})

test('PDF extraction cleans up and non-extractable PDFs produce readable notices', async () => {
  let destroyed = 0
  const api = await loadApi({
    pdfjs: {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'PDF text' }] }) }),
        }),
        destroy: async () => {
          destroyed++
        },
      }),
    },
  })
  const parts = await api.toOpenaiFileParts(
    { blob: new Blob(['pdf']), name: 'x.pdf', isImage: false },
    signal()
  )
  assert.match(parts[0].text, /PDF text/)
  assert.equal(destroyed, 1)
  const failed = await loadApi({
    pdfjs: {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.reject(new Error('bad pdf')),
        destroy: async () => {},
      }),
    },
  })
  assert.equal(
    (
      await failed.toOpenaiFileParts(
        { blob: new Blob(['bad']), name: 'x.pdf', isImage: false },
        signal()
      )
    )[0].type,
    'text'
  )
})

test('recorded SSE maps thinking, text, citations, finish reason and trailing usage before DONE', async () => {
  const api = await loadApi()
  const events = await collect(
    api.openaiStreamEvents(
      sseBody(readFileSync(new URL('./openai.fixture.txt', import.meta.url), 'utf8')),
      'model',
      signal()
    )
  )
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]
  )
  assert.equal(events[1].content_block.type, 'thinking')
  assert.equal(events[2].delta.thinking, 'Think first')
  assert.equal(events[5].delta.text, 'Hello ')
  assert.equal(events[7].delta.citation.url, 'https://example.com')
  assert.deepEqual(events.at(-2).usage, {
    input_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 3,
    output_tokens: 5,
  })
  assert.equal(events.at(-2).delta.stop_reason, 'end_turn')
})

test('empty, error, malformed, interrupted, filtered and aborted streams', async () => {
  const api = await loadApi()
  for (const [finish, expected] of [
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['tool_calls', 'end_turn'],
  ]) {
    const events = await collect(
      api.openaiStreamEvents(
        sseBody(body([{ choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]'])),
        'm',
        signal()
      )
    )
    assert.equal(events.at(-2).delta.stop_reason, expected)
  }
  for (const [stream, kind] of [
    ['', 'interrupted'],
    [body(['[DONE]']), 'protocol'],
    [body([{ error: { message: 'upstream failed' } }]), 'stream'],
    ['event: error\ndata: unavailable\n\n', 'stream'],
    ['data: not json\n\n', 'protocol'],
    [body([{ choices: [{ delta: { content: 'partial' } }] }]), 'interrupted'],
  ]) {
    await assert.rejects(collect(api.openaiStreamEvents(sseBody(stream), 'm', signal())), { kind })
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    collect(api.openaiStreamEvents(sseBody(body([{ choices: [] }])), 'm', controller.signal)),
    { name: 'AbortError' }
  )
})

test('recorded live upstream SSE completes with reasoning, text and usage', async () => {
  const api = await loadApi()
  const events = await collect(
    api.openaiStreamEvents(
      sseBody(readFileSync(new URL('./openai.live.fixture.txt', import.meta.url), 'utf8')),
      'recorded-model',
      signal()
    )
  )
  assert.equal(events.at(-1).type, 'message_stop')
  assert.ok(events.some((event) => event.delta?.type === 'thinking_delta'))
  assert.ok(events.some((event) => event.delta?.type === 'text_delta'))
  assert.ok(events.at(-2).usage.output_tokens > 0)
})

test('HTTP errors surface and title generation is separate, small and reasoning off', async () => {
  const calls = []
  let response = Response.json({ choices: [{ message: { content: '"Short title"' } }] })
  const api = await loadApi({
    fetch: async (url, init) => {
      calls.push([url, JSON.parse(init.body)])
      return response
    },
  })
  assert.equal(
    await api.generateOpenaiTitle('https://example.test/v1', 'key', 'm', 'q', 'a', signal()),
    'Short title'
  )
  assert.equal(calls[0][0], 'https://example.test/v1/chat/completions')
  assert.equal(calls[0][1].stream, false)
  assert.equal(calls[0][1].reasoning_effort, 'none')
  assert.equal(calls[0][1].max_tokens, 64)
  response = Response.json({ error: { message: 'denied' } }, { status: 403 })
  await assert.rejects(
    collect(api.streamOpenaiMessage('https://example.test/v1', 'key', { model: 'm' }, signal())),
    { kind: 'http', status: 403, message: 'denied' }
  )
  response = new Response('<html>not models</html>')
  await assert.rejects(api.verifyApiKey('key', 'https://example.test/v1'))
})
