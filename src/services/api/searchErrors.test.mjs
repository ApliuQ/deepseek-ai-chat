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

test('an initial search HTTP 400 retries the same endpoint once without search configuration', async () => {
  for (const method of ['client', 'chat', 'responses']) {
    const root = 'https://gateway.test/v1'
    const endpoint = root + (method === 'responses' ? '/responses' : '/chat/completions')
    const calls = []
    const api = await loadApi({
      locale: method === 'responses' ? en : undefined,
      storage: {
        getItem: () => JSON.stringify({ method, expires: Date.now() + 60000 }),
        removeItem: () => {},
      },
      fetch: async (url, init) => {
        assert.equal(url, endpoint)
        calls.push(JSON.parse(init.body))
        if (calls.length === 1) {
          return Response.json({ error: { message: 'bad request' } }, { status: 400 })
        }
        return method === 'responses'
          ? new Response(
              sseBody(
                'data: {"type":"response.output_text.delta","delta":"Offline answer."}\n\n' +
                  'data: {"type":"response.completed","response":{"output":[]}}\n\n'
              ),
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          : chat({ content: 'Offline answer.' })
      },
    })
    const events = await collect(
      api.streamOpenaiMessage(root, 'key', await searchRequest(api), signal())
    )
    const { tools, tool_choice, web_search_options, include, ...plain } = calls[0]
    if (method === 'responses') {
      assert.deepEqual(tools, [{ type: 'web_search' }])
      assert.deepEqual(include, ['web_search_call.action.sources'])
    } else if (method === 'chat') {
      assert.deepEqual(web_search_options, {})
    } else {
      assert.equal(tool_choice, 'auto')
      assert.deepEqual(
        tools.map((tool) => tool.function.name),
        ['web_search', 'fetch_url']
      )
    }
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], plain)
    const text = replyText(events)
    assert.match(text, /Offline answer\./)
    assert.ok(
      text.includes(
        method === 'responses'
          ? en.customSearchFallback
          : '当前模型不支持联网搜索，已改为不联网回答'
      )
    )
    assert.doesNotMatch(text, /HTTP 400|bad request/)
    assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
    assert.equal(events.at(-1).type, 'message_stop')
  }
})

test('a failed offline retry or a non-400 search failure retains the request error', async () => {
  for (const statuses of [[400, 400], [400, 403], [401], [403], [429], [500], [502]]) {
    const calls = []
    const api = await loadApi({
      fetch: async (_url, init) => {
        const status = statuses[calls.length]
        calls.push(JSON.parse(init.body))
        return Response.json({ error: { message: 'private gateway detail' } }, { status })
      },
    })
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await searchRequest(api), signal())
    )
    assert.equal(calls.length, statuses.length)
    assert.ok(calls[0].tools?.length)
    if (calls.length > 1) {
      assert.equal(calls[1].tools, undefined)
    }
    const text = replyText(events)
    assert.ok(text.includes('请求模型接口失败：服务返回 HTTP ' + statuses.at(-1)))
    assert.doesNotMatch(text, /当前模型不支持联网搜索|private gateway detail/)
  }
})

test('HTTP 400 after a model tool call does not restart the reply without search', async () => {
  const calls = []
  const api = await loadApi({
    storage: {
      getItem: () => JSON.stringify({ method: 'client', expires: Date.now() + 60000 }),
      removeItem: () => {},
    },
    fetch: async (url, init) => {
      if (url === 'https://mcp.exa.ai/mcp') {
        return Response.json({
          id: 1,
          result: { content: [{ type: 'text', text: 'Title: News\nURL: https://example.com' }] },
        })
      }
      calls.push(JSON.parse(init.body))
      return calls.length === 1
        ? chat(searchCall(), 'tool_calls')
        : Response.json({ error: { message: 'bad request' } }, { status: 400 })
    },
  })
  const text = replyText(
    await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await searchRequest(api), signal())
    )
  )
  assert.equal(calls.length, 2)
  assert.ok(calls[1].messages.some((message) => message.role === 'tool'))
  assert.match(text, /请求模型接口失败：服务返回 HTTP 400/)
  assert.doesNotMatch(text, /当前模型不支持联网搜索/)
})

test('a custom model HTTP failure preserves the full sanitized response separately from the notice', async () => {
  const raw =
    '{\n  "error": {"message":"denied", "request_id":"mock-123"},\n' +
    '  "key":"current-fake-key", "Authorization":"Basic mock-basic",\n' +
    '  "detail":"Bearer mock-bearer sk-mock_credential https://gateway.test/path?token=mock-query"\n}'
  const api = await loadApi({
    fetch: async () => new Response(raw, { status: 502 }),
  })
  const events = await collect(
    api.streamOpenaiMessage(
      'https://gateway.test/v1',
      'current-fake-key',
      await searchRequest(api),
      signal()
    )
  )
  const details = events.find((event) => event.content_block?.responseDetails).content_block
    .responseDetails
  assert.equal(details.status, 502)
  assert.equal(details.truncated, false)
  assert.equal(
    details.body,
    raw
      .replace('current-fake-key', '***')
      .replace('Basic mock-basic', '***')
      .replace('Bearer mock-bearer', '***')
      .replace('sk-mock_credential', '***')
      .replace('?token=mock-query', '')
  )
  assert.doesNotMatch(replyText(events), /mock-123|denied/)
})

test('custom chat, client search and Responses preserve the failing SSE data, not other frames', async () => {
  for (const [method, event, data] of [
    ['chat', '', '{ "error": {"message":"failed","code":"mock"} }'],
    ['client', 'event: error\n', 'plain failure\ndata: on a second line'],
    ['responses', 'event: response.failed\n', '{ "response":{"error":{"message":"failed"}} }'],
  ]) {
    const api = await loadApi({
      storage: {
        getItem: () => JSON.stringify({ method, expires: Date.now() + 60000 }),
        removeItem: () => {},
      },
      fetch: async (url) => {
        if (
          method !== 'client' &&
          !url.endsWith(method === 'chat' ? '/chat/completions' : '/responses')
        ) {
          return chat({ content: 'Done' })
        }
        return new Response(sseBody(`: keepalive\n\n${event}data: ${data}\n\n`), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await searchRequest(api), signal())
    )
    const details = events.find((event) => event.content_block?.responseDetails).content_block
      .responseDetails
    assert.equal(details.body, data.replace('\ndata: ', '\n'))
    assert.equal(details.status, undefined)
    assert.equal(details.truncated, false)
  }
})

test('response details redact before truncating at the UTF-8 byte limit', async () => {
  const raw = '字'.repeat(6824) + ' sk-mock-' + 'a'.repeat(80) + '文'.repeat(40)
  const api = await loadApi({ fetch: async () => new Response(raw, { status: 400 }) })
  await assert.rejects(
    api.requestCustomModel('https://gateway.test/v1', 'mock-key', {}),
    (error) => {
      assert.equal(error.responseDetails.truncated, true)
      assert.ok(Buffer.byteLength(error.responseDetails.body) <= 20 * 1024)
      assert.ok(error.responseDetails.body.startsWith('字'.repeat(6824) + ' ***'))
      assert.doesNotMatch(error.responseDetails.body, /sk-mock|�/)
      return true
    }
  )
})

test('Exa preserves the relevant SSE error data and redacts echoed header arrays', async () => {
  const data = '{ "id":null, "error": {"message":"denied"}, "authorization": ["Basic private"] }'
  const api = await loadApi({
    fetch: async () =>
      new Response(sseBody('data: {"method":"progress"}\n\n' + 'data: ' + data + '\n\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  })
  await assert.rejects(api.searchBrowserWeb('query', signal()), (error) => {
    assert.equal(error.responseDetails.body, data.replace('"Basic private"', '"***"'))
    assert.equal(error.responseDetails.status, undefined)
    return true
  })
})

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
  await assert.rejects(
    api.fetchBrowserUrl('https://example.com/page?token=secret', signal()),
    (error) => {
      assert.deepEqual(
        { ...error.responseDetails },
        {
          status: 429,
          body: '{"error":{"message":"specific provider failure"}}',
          truncated: false,
        }
      )
      return true
    }
  )
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
    assert.equal(
      events.find((event) => event.content_block?.responseDetails).content_block.responseDetails
        .body,
      '{"error":{"message":"actual upstream limit"}}'
    )
    assert.doesNotMatch(text, /Search unavailable for this turn/)
    const results = histories[reply].filter((m) => m.role === 'tool')
    assert.equal(results.length, 2)
    assert.ok(results.every((m) => !m.content.includes('actual upstream limit')))
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
