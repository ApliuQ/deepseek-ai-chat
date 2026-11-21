import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, loadApi, sseBody } from './testHarness.mjs'
const signal = () => new AbortController().signal

test('search failures retain bounded HTTP status and actual hosted/Exa/Jina error messages', async () => {
  const api = await loadApi({
    fetch: async () =>
      Response.json({ error: { message: 'specific provider failure' } }, { status: 429 }),
  })
  assert.match(
    api.searchFailureNote(new api.ApiError('http', 'specific provider failure', 429)),
    /当前模型不支持联网搜索：HTTP 429: specific provider failure/
  )
  assert.ok(api.searchFailureNote(new Error('x'.repeat(5000))).length < 550)
  assert.doesNotMatch(api.searchFailureNote(new Error('sk-' + 'x'.repeat(30))), /sk-/)
  await assert.rejects(api.searchBrowserWeb('query', signal()), {
    status: 429,
    message: 'specific provider failure',
  })
  await assert.rejects(api.fetchBrowserUrl('https://example.com', signal()), {
    status: 429,
    message: 'specific provider failure',
  })
})

test('parallel search calls retain the actual first failure instead of a fixed unavailable message', async () => {
  let searches = 0
  const stream = (delta, finish) =>
    new Response(
      sseBody(
        [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
          .map(
            (frame) =>
              'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n'
          )
          .join('')
      ),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url.includes('mcp.exa.ai')) {
        searches++
        return Response.json({ error: { message: 'actual upstream limit' } }, { status: 429 })
      }
      const body = JSON.parse(init.body)
      return body.messages.some((m) => m.role === 'tool')
        ? stream({ content: 'Cannot verify news.' }, 'stop')
        : stream(
            {
              tool_calls: [0, 1].map((index) => ({
                index,
                id: 'call' + index,
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"news"}' },
              })),
            },
            'tool_calls'
          )
    },
  })
  const body = {
    model: 'model',
    stream: true,
    stream_options: { include_usage: true },
    messages: [],
    tools: [api.WEB_SEARCH_TOOL],
  }
  const events = await collect(
    api.streamClientMessage('https://gateway.test/v1', 'key', body, signal())
  )
  const text = events.map((e) => e.content_block?.text ?? e.delta?.text ?? '').join('')
  assert.equal(searches, 1)
  assert.equal(text.match(/HTTP 429: actual upstream limit/g).length, 2)
  assert.doesNotMatch(text, /Search unavailable for this turn/)
})

test('hosted HTTP errors remain visible even if a lower tier answers', async () => {
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url.endsWith('/responses')) {
        return Response.json({ error: { message: 'hosted channel exploded' } }, { status: 502 })
      }
      const body = JSON.parse(init.body)
      if (body.web_search_options) {
        return Response.json({ error: { message: 'chat hosted denied' } }, { status: 403 })
      }
      return new Response(
        sseBody(
          'data: {"choices":[{"delta":{"content":"knowledge answer"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        ),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    },
  })
  await api.detectSearchMethod('https://host.test/v1', 'key', 'model', signal())
  // 强制使用已缓存的 Chat 能力，覆盖运行时降级。
  const values = new Map()
  const seeded = await loadApi({
    storage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
    fetch: async (url, init) => {
      const b = JSON.parse(init.body)
      if (b.stream === false) {
        return Response.json({
          choices: [
            {
              message: {
                annotations: [
                  { type: 'url_citation', url_citation: { url: 'https://example.com' } },
                ],
              },
            },
          ],
        })
      }
      if (url.endsWith('/responses')) {
        return Response.json({ error: { message: 'hosted channel exploded' } }, { status: 502 })
      }
      if (b.web_search_options) {
        return Response.json({ error: { message: 'chat hosted denied' } }, { status: 403 })
      }
      return new Response(
        sseBody(
          'data: {"choices":[{"delta":{"content":"knowledge answer"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        ),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    },
  })
  await seeded.detectSearchMethod('https://host.test/v1', 'key', 'model', signal())
  const body = await seeded.buildOpenaiRequest(
    [],
    'model',
    false,
    true,
    async () => undefined,
    signal()
  )
  const events = await collect(
    seeded.streamOpenaiMessage('https://host.test/v1', 'key', body, signal())
  )
  const text = events.map((e) => e.content_block?.text ?? e.delta?.text ?? '').join('')
  assert.match(text, /HTTP 403: chat hosted denied/)
  assert.match(text, /HTTP 502: hosted channel exploded/)
  assert.match(text, /knowledge answer/)
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
})
