import assert from 'node:assert/strict'
import test from 'node:test'
import { en } from '../../i18n/en.ts'
import { collect, loadApi, sseBody } from './testHarness.mjs'
const signal = () => new AbortController().signal

const chat = (delta, finish = 'stop') =>
  new Response(
    sseBody(
      [{ choices: [{ delta, finish_reason: finish }] }, '[DONE]']
        .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
        .join('')
    ),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const searchCall = (query = 'latest news') => ({
  tool_calls: [
    {
      index: 0,
      id: 'search',
      function: { name: 'web_search', arguments: JSON.stringify({ query }) },
    },
  ],
})
const replyText = (events) =>
  events.map((event) => event.content_block?.text ?? event.delta?.text ?? '').join('')
const searchRequest = (api) =>
  api.buildOpenaiRequest([], 'model', false, true, async () => undefined, signal())

test('a browser fetch failure names the operation and URL without blaming the model', async () => {
  for (const target of ['gateway', 'exa']) {
    const api = await loadApi({
      locale: target === 'gateway' ? en : undefined,
      fetch: async (url, init) => {
        if (target === 'gateway' || url === 'https://mcp.exa.ai/mcp') {
          throw new TypeError('Failed to fetch: Authorization: Bearer private-value')
        }
        const body = JSON.parse(init.body)
        if (!body.stream) {
          throw new TypeError('Failed to fetch while detecting capabilities')
        }
        return body.messages.some((m) => m.role === 'tool')
          ? chat({ content: 'Answer without verified sources.' })
          : chat(searchCall(), 'tool_calls')
      },
    })
    const text = replyText(
      await collect(
        api.streamOpenaiMessage(
          'https://gateway.test/v1',
          'private-value',
          await searchRequest(api),
          signal()
        )
      )
    )
    if (target === 'gateway') {
      assert.match(
        text,
        /Model API request failed: the connection failed or the browser blocked the request/
      )
      assert.match(text, /https:\/\/gateway\.test\/v1\/chat\/completions/)
    } else {
      assert.match(text, /联网搜索（Exa）失败：网络连接失败，或请求被浏览器拦截/)
      assert.match(text, /https:\/\/mcp\.exa\.ai\/mcp/)
      assert.doesNotMatch(text, /请求模型接口失败/)
    }
    assert.doesNotMatch(
      text,
      /当前模型不支持联网搜索|does not support web search|Failed to fetch|Authorization|private-value/
    )
  }
})

test('search capabilities failing to probe do not label a successful client search unsupported', async () => {
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url === 'https://mcp.exa.ai/mcp') {
        return Response.json({
          id: 1,
          result: {
            content: [
              { type: 'text', text: 'Title: News\nURL: https://example.com\nHighlights: News' },
            ],
          },
        })
      }
      const body = JSON.parse(init.body)
      if (!body.stream) {
        throw new TypeError('Failed to fetch')
      }
      return body.messages.some((m) => m.role === 'tool')
        ? chat({ content: 'Verified news: https://example.com/' })
        : chat(searchCall(), 'tool_calls')
    },
  })
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', await searchRequest(api), signal())
  )
  assert.ok(events.some((event) => event.content_block?.content?.[0]?.type === 'web_search_result'))
  assert.doesNotMatch(replyText(events), /当前模型不支持联网搜索|请求模型接口失败/)
})

test('unsupported search requires a model search call that never executes', async () => {
  for (const requestedSearch of [false, true]) {
    let requests = 0
    const api = await loadApi({
      fetch: async (url, init) => {
        assert.match(url, /chat\/completions$/)
        assert.equal(JSON.parse(init.body).stream, true)
        requests++
        return requestedSearch && requests === 1
          ? chat(searchCall(' '), 'tool_calls')
          : chat({ content: 'Answer without verified sources.' })
      },
    })
    const text = replyText(
      await collect(
        api.streamOpenaiMessage(
          'https://gateway.test/v1',
          'key',
          await searchRequest(api),
          signal()
        )
      )
    )
    assert.match(text, /Answer without verified sources/)
    assert.equal(text.includes('当前模型不支持联网搜索'), requestedSearch)
    assert.equal(requests, requestedSearch ? 2 : 1)
  }
})

test('failed hosted search tries client fallback before reporting unsupported', async () => {
  for (const clientCanSearch of [true, false]) {
    let exaRequests = 0
    const api = await loadApi({
      storage: {
        getItem: () => JSON.stringify({ method: 'responses', expires: Date.now() + 60000 }),
        removeItem: () => {},
      },
      fetch: async (url, init) => {
        if (url.endsWith('/responses')) {
          return new Response(
            sseBody(
              'data: {"type":"response.completed","response":{"output":[{"type":"web_search_call","id":"hosted","status":"failed"}]}}\n\n'
            ),
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        if (url === 'https://mcp.exa.ai/mcp') {
          exaRequests++
          return Response.json({
            id: 1,
            result: { content: [{ type: 'text', text: 'Title: News\nURL: https://example.com' }] },
          })
        }
        const body = JSON.parse(init.body)
        return clientCanSearch && !body.messages.some((m) => m.role === 'tool')
          ? chat(searchCall(), 'tool_calls')
          : chat({ content: 'Client fallback answer.' })
      },
    })
    const text = replyText(
      await collect(
        api.streamOpenaiMessage(
          'https://gateway.test/v1',
          'key',
          await searchRequest(api),
          signal()
        )
      )
    )
    assert.equal(exaRequests, clientCanSearch ? 1 : 0)
    assert.equal(text.includes('当前模型不支持联网搜索'), !clientCanSearch)
    assert.match(text, /Client fallback answer/)
  }
})

test('a completed Responses search event clears an unfulfilled Chat search', async () => {
  const requests = []
  const api = await loadApi({
    storage: {
      getItem: () => JSON.stringify({ method: 'chat', expires: Date.now() + 60000 }),
      removeItem: () => {},
    },
    fetch: async (url) => {
      requests.push(url)
      return url.endsWith('/chat/completions')
        ? chat(searchCall(), 'tool_calls')
        : new Response(
            sseBody(
              'data: {"type":"response.web_search_call.completed","item_id":"hosted"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":"Hosted search answer."}\n\n' +
                'data: {"type":"response.completed","response":{"output":[]}}\n\n'
            ),
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
    },
  })
  const text = replyText(
    await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await searchRequest(api), signal())
    )
  )
  assert.deepEqual(requests, [
    'https://gateway.test/v1/chat/completions',
    'https://gateway.test/v1/responses',
  ])
  assert.match(text, /Hosted search answer/)
  assert.doesNotMatch(text, /当前模型不支持联网搜索/)
})

test('search failures preserve HTTP status and redact service error bodies and URL secrets', async () => {
  const api = await loadApi({
    fetch: async () =>
      Response.json({ error: { message: 'specific provider failure' } }, { status: 429 }),
  })
  const failure = api.customRequestError(
    'customModelRequest',
    'https://account:password@gateway.test/v1/my%20key/chat?token=query-secret#secret-fragment',
    new api.ApiError('http', 'Authorization: Bearer my key', 429),
    'my key'
  )
  assert.equal(failure.status, 429)
  assert.equal(failure.localMessage.params.url, 'https://gateway.test/v1/…/chat')
  assert.doesNotMatch(
    failure.message,
    /account|password|Authorization|my key|query-secret|secret-fragment/
  )
  await assert.rejects(api.searchBrowserWeb('query', signal()), {
    status: 429,
    message: '联网搜索（Exa）失败：服务返回 HTTP 429。请求地址：https://mcp.exa.ai/mcp',
  })
  await assert.rejects(api.fetchBrowserUrl('https://example.com/page?token=secret', signal()), {
    status: 429,
    message:
      '读取网页失败：服务返回 HTTP 429。请求地址：https://r.jina.ai/https://example.com/page',
  })
})

test('parallel search calls show the actual failure once per reply and preserve every tool result', async () => {
  let searches = 0
  const histories = []
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
      if (body.messages.some((m) => m.role === 'tool')) {
        histories.push(body.messages)
      }
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
  for (let reply = 0; reply < 2; reply++) {
    const events = await collect(
      api.streamClientMessage('https://gateway.test/v1', 'key', body, signal())
    )
    const text = events.map((e) => e.content_block?.text ?? e.delta?.text ?? '').join('')
    assert.equal(searches, reply + 1)
    assert.equal(text.match(/联网搜索（Exa）失败：服务返回 HTTP 429/g).length, 1)
    assert.doesNotMatch(text, /当前模型不支持联网搜索|actual upstream limit/)
    assert.doesNotMatch(text, /Search unavailable for this turn/)
    const results = histories[reply].filter((m) => m.role === 'tool')
    assert.equal(results.length, 2)
    assert.ok(results.every((m) => JSON.parse(m.content).error.includes('HTTP 429')))
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  }
})

test('an empty continuation does not repeat the already displayed search failure', async () => {
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url.includes('mcp.exa.ai')) {
        return Response.json({ error: { message: 'actual upstream limit' } }, { status: 429 })
      }
      const body = JSON.parse(init.body)
      const frames = body.messages.some((m) => m.role === 'tool')
        ? [{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'search',
                        type: 'function',
                        function: { name: 'web_search', arguments: '{"query":"news"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]
      return new Response(
        sseBody(
          [...frames, '[DONE]']
            .map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n')
            .join('')
        ),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    },
  })
  const events = await collect(
    api.streamClientMessage(
      'https://gateway.test/v1',
      'key',
      {
        model: 'model',
        stream: true,
        stream_options: { include_usage: true },
        messages: [],
        tools: [api.WEB_SEARCH_TOOL],
      },
      signal()
    )
  )
  const notes = events.filter(
    (e) => e.content_block?.type === 'text' && e.content_block.text.includes('联网搜索（Exa）失败')
  )
  assert.equal(notes.length, 1)
  assert.match(notes[0].content_block.text, /HTTP 429/)
  assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
})

test('hosted and client request failures identify their endpoints without exposing service messages', async () => {
  for (const distinct of [false, true]) {
    const values = new Map()
    const stream = (delta, finish) =>
      new Response(
        sseBody(
          [{ choices: [{ delta, finish_reason: finish }] }, '[DONE]']
            .map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n')
            .join('')
        ),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    const api = await loadApi({
      storage: {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => values.set(k, v),
        removeItem: (k) => values.delete(k),
      },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        const tier = url.includes('mcp.exa.ai')
          ? 'client'
          : url.endsWith('/responses')
            ? 'responses'
            : body.web_search_options
              ? 'chat'
              : null
        if (tier) {
          return Response.json(
            { error: { message: distinct ? tier + ' failure' : 'same failure' } },
            { status: 503 }
          )
        }
        return body.messages.some((m) => m.role === 'tool')
          ? stream({ content: 'Knowledge answer.' }, 'stop')
          : stream(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'search',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"news"}' },
                  },
                ],
              },
              'tool_calls'
            )
      },
    })
    values.set(
      api.searchCapabilityKey('https://gateway.test/v1', 'model'),
      JSON.stringify({ method: 'chat', expires: Date.now() + 60000 })
    )
    const body = await api.buildOpenaiRequest(
      [],
      'model',
      false,
      true,
      async () => undefined,
      signal()
    )
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
    )
    const notes = events
      .filter(
        (e) =>
          e.content_block?.type === 'text' && e.content_block.text.includes('服务返回 HTTP 503')
      )
      .map((e) => e.content_block.text)
    assert.equal(notes.length, 3)
    for (const endpoint of [
      'gateway.test/v1/chat/completions',
      'gateway.test/v1/responses',
      'mcp.exa.ai/mcp',
    ]) {
      assert.equal(notes.filter((n) => n.includes(endpoint)).length, 1)
    }
    assert.doesNotMatch(
      notes.join(''),
      /当前模型不支持联网搜索|same failure|(?:chat|responses|client) failure/
    )
    assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  }
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
  assert.match(text, /请求模型接口失败：服务返回 HTTP 403.*host\.test\/v1\/chat\/completions/)
  assert.match(text, /请求模型接口失败：服务返回 HTTP 502.*host\.test\/v1\/responses/)
  assert.doesNotMatch(text, /当前模型不支持联网搜索|chat hosted denied|hosted channel exploded/)
  assert.match(text, /knowledge answer/)
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
})
