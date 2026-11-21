import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, loadApi, sseBody } from './testHarness.mjs'

const signal = () => new AbortController().signal
const mcp = (text, sse = true) => {
  const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }
  return sse
    ? new Response(sseBody(`event: message\ndata: ${JSON.stringify(body)}\n\n`), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    : Response.json(body)
}

test('Exa parses SSE and JSON and sends objective without credentials', async () => {
  for (const sse of [true, false]) {
    const api = await loadApi({
      fetch: async (url, init) => {
        assert.equal(url, 'https://mcp.exa.ai/mcp')
        assert.equal(init.credentials, 'omit')
        assert.equal(init.referrerPolicy, 'no-referrer')
        assert.equal(init.headers.Authorization, undefined)
        assert.equal(init.headers.Cookie, undefined)
        const body = JSON.parse(init.body)
        assert.equal(body.params.name, 'web_search_exa')
        assert.ok(body.params.arguments.objective)
        return mcp(
          'Title: Source\nURL: https://example.com/\nHighlights:\nUseful facts\n\nTitle: Bad\nURL: javascript:alert(1)\nHighlights:\nBad',
          sse
        )
      },
    })
    const results = await api.searchBrowserWeb('news', signal())
    assert.equal(results.length, 1)
    assert.equal(results[0].snippet, 'Useful facts')
  }
})

test('fetch_url uses Exa and falls back to Jina, propagating failures and aborts', async () => {
  for (const fallback of [false, true]) {
    const calls = []
    const api = await loadApi({
      fetch: async (url, init) => {
        calls.push(url)
        assert.equal(init.headers?.Authorization, undefined)
        assert.equal(init.credentials, 'omit')
        if (url.includes('mcp.exa.ai')) {
          const body = JSON.parse(init.body)
          assert.equal(body.params.name, 'web_fetch_exa')
          assert.deepEqual(body.params.arguments.urls, ['https://example.com/'])
          return fallback ? new Response('', { status: 429 }) : mcp('# Example\nUseful content')
        }
        return new Response('Title: Example\nUseful reader content')
      },
    })
    assert.match((await api.fetchBrowserUrl('https://example.com/', signal()))[0].snippet, /Useful/)
    assert.equal(calls.length, fallback ? 2 : 1)
    await assert.rejects(
      api.fetchBrowserUrl('https://user:password@example.com', signal()),
      /credentials/
    )
    await assert.rejects(api.fetchBrowserUrl('file:///etc/passwd', signal()), /HTTP/)
  }
  const api = await loadApi({ fetch: async () => new Response('', { status: 503 }) })
  await assert.rejects(api.fetchBrowserUrl('https://example.com', signal()), /503/)
})

test('web provider rejects invalid, oversized and MCP error responses and reports timeout', async () => {
  for (const response of [
    () => Response.json({ id: 1, error: { message: 'Unavailable' } }),
    () => Response.json({ id: 1, result: { isError: true } }),
    () => Response.json({ nonsense: true }),
    () => mcp(''),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const api = await loadApi({ fetch: async () => response() })
    await assert.rejects(api.searchBrowserWeb('news', signal()))
  }
  const api = await loadApi({
    timer: (fn) => setTimeout(fn, 1),
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })
  await assert.rejects(api.searchBrowserWeb('news', signal()), /timed out/)
})

test('literal-only replies never finish blank, including Search off', async () => {
  for (const search of [false, true]) {
    const api = await loadApi({
      fetch: async () =>
        new Response(
          sseBody(
            'data: {"choices":[{"delta":{"content":"<tool_call>bad</tool_call>"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          ),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    })
    const body = await api.buildOpenaiRequest(
      [],
      'model',
      false,
      search,
      async () => undefined,
      signal()
    )
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'secret', body, signal())
    )
    const text = events.map((e) => e.content_block?.text ?? e.delta?.text ?? '').join('')
    assert.match(text, /no usable answer/)
    assert.doesNotMatch(text, /tool_call/)
  }
})

test('fetch_url tool calls continue through the app loop with page text and citations', async () => {
  const completion = (delta, finish = 'stop') =>
    new Response(
      sseBody(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`
      ),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url === 'https://mcp.exa.ai/mcp') {
        return mcp('# Example\nPage verification: 4821')
      }
      const body = JSON.parse(init.body)
      if (body.messages.some((m) => m.role === 'tool')) {
        assert.match(body.messages.at(-1).content, /Page verification: 4821/)
        return completion({ content: '4821 — https://example.com/' })
      }
      return completion(
        {
          tool_calls: [
            {
              index: 0,
              id: 'read',
              function: { name: 'fetch_url', arguments: '{"url":"https://example.com/"}' },
            },
          ],
        },
        'tool_calls'
      )
    },
  })
  const body = await api.buildOpenaiRequest(
    [],
    'model',
    false,
    true,
    async () => undefined,
    signal()
  )
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'secret', body, signal())
  )
  assert.ok(events.some((e) => e.delta?.citation?.url === 'https://example.com/'))
})
