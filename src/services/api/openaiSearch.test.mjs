import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, loadApi as loadBaseApi, sseBody } from './testHarness.mjs'

const loadApi = async (options) => {
  const api = await loadBaseApi(options)
  return {
    ...api,
    openaiStreamEvents: api.clientSearchStreamEvents,
    streamOpenaiMessage: api.streamClientMessage,
    buildOpenaiRequest: async (...args) => {
      const body = await api.buildOpenaiRequest(...args)
      delete body.web_search_options
      if (args[3]) {
        body.tools = [api.WEB_SEARCH_TOOL, api.FETCH_URL_TOOL]
        body.tool_choice = 'auto'
      }
      return body
    },
  }
}
const signal = () => new AbortController().signal
const exaResponse = (results = []) =>
  Response.json({
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: results.length
            ? results
                .map(
                  ({ title, url, snippet }) =>
                    `Title: ${title}\nURL: ${url}\nHighlights:\n${snippet}`
                )
                .join('\n\n')
            : 'No results found',
        },
      ],
    },
  })
const frames = (deltas, finish = 'stop') =>
  [
    ...deltas.map((delta) => ({ choices: [{ delta }] })),
    {
      choices: [{ delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
    '[DONE]',
  ]
    .map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
    .join('')
const response = (deltas, finish) =>
  new Response(sseBody(frames(deltas, finish)), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
const call = (query = 'DeepSeek news') => ({
  tool_calls: [
    {
      index: 0,
      id: 'call_search',
      type: 'function',
      function: { name: 'web_search', arguments: JSON.stringify({ query }) },
    },
  ],
})
const makeRequest = (api, search = true) =>
  api.buildOpenaiRequest(
    [{ role: 'user', content: 'Search for DeepSeek news' }],
    'model',
    false,
    search,
    async () => undefined,
    signal()
  )
const text = (events) =>
  events
    .map((e) => e.delta?.text ?? (e.content_block?.type === 'text' ? e.content_block.text : ''))
    .join('')

test('long queries reach Exa unchanged and only real service failures show an unavailable note', async () => {
  for (const query of ['q'.repeat(129), '搜'.repeat(200), '😀'.repeat(200)]) {
    for (const status of [200, 400]) {
      const searches = []
      const histories = []
      let unavailable = 0
      const api = await loadApi({
        fetch: async (url, init) => {
          const body = JSON.parse(init.body)
          if (url === 'https://mcp.exa.ai/mcp') {
            searches.push(body.params.arguments.query)
            return status === 200
              ? exaResponse([{ title: 'Source', url: 'https://example.com', snippet: 'News' }])
              : Response.json({ error: { message: 'Exa rejected this query' } }, { status })
          }
          histories.push(body.messages)
          return body.messages.some((m) => m.role === 'tool')
            ? response([{ content: 'Final answer.' }])
            : response([call(query)], 'tool_calls')
        },
      })
      const events = await collect(
        api.streamClientMessage(
          'https://gateway.test/v1',
          'key',
          await makeRequest(api),
          signal(),
          () => unavailable++
        )
      )
      assert.deepEqual(searches, [query])
      assert.equal(unavailable, status === 200 ? 0 : 1)
      const tool = JSON.parse(histories[1].find((m) => m.role === 'tool').content)
      if (status === 200) {
        assert.doesNotMatch(text(events), /当前模型不支持联网搜索/)
        assert.equal(tool.results[0].title, 'Source')
      } else {
        assert.match(text(events), /联网搜索（Exa）失败：服务返回 HTTP 400/)
        assert.match(tool.error, /HTTP 400/)
        assert.doesNotMatch(text(events), /当前模型不支持联网搜索|Exa rejected this query/)
      }
      assert.match(text(events), /Final answer/)
    }
  }
})

test('invalid search arguments return tool errors and allow a corrected query without disabling search', async () => {
  for (const [args, literal] of [
    ['{"query":""}', false],
    ['{"query":"  \\n  "}', false],
    ['{', false],
    ['{"query":null}', false],
    ['{"query":7}', false],
    ['{"query":""}', true],
  ]) {
    let searches = 0
    let unavailable = 0
    let beforeSearch = 0
    const histories = []
    const api = await loadApi({
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        if (url === 'https://mcp.exa.ai/mcp') {
          searches++
          assert.equal(body.params.arguments.query, 'correct query')
          return exaResponse([{ title: 'Source', url: 'https://example.com', snippet: 'News' }])
        }
        histories.push(body)
        if (histories.length === 1) {
          const invalid = call()
          invalid.tool_calls[0].function.arguments = args
          return literal
            ? response([
                { content: `<tool_call>{"name":"web_search","arguments":${args}}</tool_call>` },
              ])
            : response([invalid], 'tool_calls')
        }
        if (histories.length === 2) {
          assert.equal(searches, 0)
          assert.equal(beforeSearch, 0)
          assert.equal(unavailable, 0)
          const tool = body.messages.find((m) => m.role === 'tool')
          assert.equal(tool.tool_call_id, literal ? 'search_0_0' : 'call_search')
          const result = JSON.parse(tool.content)
          assert.ok(result.error)
          assert.match(result.instruction, /retry/i)
          assert.doesNotMatch(result.error, /当前模型不支持联网搜索/)
          assert.ok(body.tools.some((t) => t.function.name === 'web_search'))
          const corrected = call('correct query')
          corrected.tool_calls[0].id = 'corrected_search'
          return response([corrected], 'tool_calls')
        }
        return response([{ content: 'Corrected search succeeded.' }])
      },
    })
    const events = await collect(
      api.streamClientMessage(
        'https://gateway.test/v1',
        'key',
        await makeRequest(api),
        signal(),
        () => unavailable++,
        async () => {
          beforeSearch++
        }
      )
    )
    assert.equal(searches, 1)
    assert.equal(beforeSearch, 1)
    assert.equal(unavailable, 0)
    assert.equal(histories.length, 3)
    assert.equal(events.filter((e) => e.content_block?.type === 'server_tool_use').length, 1)
    assert.doesNotMatch(text(events), /当前模型不支持联网搜索/)
    assert.match(text(events), /Corrected search succeeded/)
  }
})

test('streamed indexed tool calls accumulate names, IDs and argument fragments', async () => {
  const api = await loadApi()
  const turn = { calls: [], content: '' }
  await collect(
    api.openaiStreamEvents(
      sseBody(
        frames(
          [
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_',
                  type: 'function',
                  function: { name: 'web_', arguments: '{"que' },
                },
              ],
            },
            {
              tool_calls: [
                {
                  index: 1,
                  id: 'other',
                  function: { name: 'web_search', arguments: '{"query":"other"}' },
                },
                { index: 0, id: 'search', function: { name: 'search', arguments: 'ry":"latest' } },
              ],
            },
            { tool_calls: [{ index: 0, function: { arguments: ' news"}' } }] },
          ],
          'tool_calls'
        )
      ),
      'model',
      signal(),
      turn
    )
  )
  assert.equal(turn.finish, 'tool_use')
  assert.equal(turn.calls.length, 2)
  assert.equal(turn.calls[0].id, 'call_search')
  assert.equal(turn.calls[0].function.name, 'web_search')
  assert.deepEqual(JSON.parse(turn.calls[0].function.arguments), { query: 'latest news' })
  assert.equal(turn.calls[1].function.name, 'web_search')
})

test('search loop posts documented payload, continues with tool results and emits search UI/citations', async () => {
  const calls = []
  const api = await loadApi({
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body, headers: init.headers })
      if (url === 'https://mcp.exa.ai/mcp') {
        return exaResponse([
          {
            title: 'DeepSeek',
            url: 'https://www.deepseek.com/',
            snippet: 'Latest official news',
            site_name: 'DeepSeek',
            date: '2026-11-21T00:00:00Z',
          },
          { url: 'javascript:alert(1)' },
        ])
      }
      return body.messages.some((m) => m.role === 'tool')
        ? response([{ content: 'See [DeepSeek](https://www.deepseek.com/).' }])
        : response([{ reasoning_content: 'Need current sources.' }, call()], 'tool_calls')
    },
  })
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', await makeRequest(api), signal())
  )
  assert.equal(calls.length, 3)
  assert.equal(calls[0].body.web_search_options, undefined)
  assert.equal(calls[0].body.tool_choice, 'auto')
  assert.equal(calls[1].url, 'https://mcp.exa.ai/mcp')
  assert.equal(calls[1].body.params.name, 'web_search_exa')
  assert.equal(calls[1].body.params.arguments.query, 'DeepSeek news')
  assert.ok(calls[1].body.params.arguments.objective)
  assert.equal(calls[1].headers.Authorization, undefined)
  const messages = calls[2].body.messages
  assert.equal(messages.at(-2).role, 'assistant')
  assert.equal(messages.at(-2).reasoning_content, 'Need current sources.')
  assert.equal(messages.at(-2).tool_calls[0].id, 'call_search')
  assert.equal(messages.at(-1).tool_call_id, 'call_search')
  assert.deepEqual(JSON.parse(messages.at(-1).content).results, [
    { title: 'DeepSeek', url: 'https://www.deepseek.com/', snippet: 'Latest official news' },
  ])
  const search = events.find(
    (e) => e.content_block?.type === 'web_search_tool_result'
  ).content_block
  assert.equal(search.content.length, 1)
  assert.equal(search.content[0].snippet, 'Latest official news')
  assert.ok(events.some((e) => e.content_block?.type === 'server_tool_use'))
  assert.ok(events.some((e) => e.delta?.citation?.url === 'https://www.deepseek.com/'))
  assert.ok(events.some((e) => e.delta?.type === 'text_delta' && e.delta.text === '\n\nSources: '))
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
  assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  const indexes = events.filter((e) => e.type === 'content_block_start').map((e) => e.index)
  assert.equal(new Set(indexes).size, indexes.length)
  assert.deepEqual(events.at(-2).usage, {
    input_tokens: 6,
    output_tokens: 4,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
})

test('denied, malformed and empty searches still allow a final answer; aborts do not continue', async () => {
  for (const result of [
    () => Response.json({ error: { message: 'rate limited by provider' } }, { status: 429 }),
    () => Response.json({ bad: [] }),
    () => exaResponse(),
  ]) {
    const calls = []
    const api = await loadApi({
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, body })
        if (url === 'https://mcp.exa.ai/mcp') {
          return result()
        }
        return body.messages.some((m) => m.role === 'tool')
          ? response([{ content: 'I cannot verify current news, but here is what I know.' }])
          : response([call()], 'tool_calls')
      },
    })
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await makeRequest(api), signal())
    )
    assert.match(text(events), /here is what I know/)
    if (JSON.parse(calls[2].body.messages.at(-1).content).error) {
      assert.match(text(events), /联网搜索（Exa）失败/)
      assert.doesNotMatch(text(events), /当前模型不支持联网搜索/)
      assert.equal(calls[2].body.tools, undefined)
      assert.equal(calls[2].body.tool_choice, 'none')
      assert.equal(
        events.find((e) => e.content_block?.type === 'web_search_tool_result').content_block
          .content[0].error_code,
        'unavailable'
      )
    }
    if (text(events).includes('429')) {
      assert.match(text(events), /服务返回 HTTP 429/)
    }
  }
  const controller = new AbortController()
  let calls = 0
  const api = await loadApi({
    fetch: async (url) => {
      calls++
      if (url === 'https://mcp.exa.ai/mcp') {
        controller.abort()
        throw new Error('aborted')
      }
      return response([call()], 'tool_calls')
    },
  })
  await assert.rejects(
    collect(
      api.streamOpenaiMessage(
        'https://gateway.test/v1',
        'key',
        await makeRequest(api),
        controller.signal
      )
    ),
    { name: 'AbortError' }
  )
  assert.equal(calls, 2)
})

test('split literal tool markup executes web_search, while malformed/unknown/dangling markup is stripped', async () => {
  for (const [markup, expectedSearches] of [
    ['<tool_call>{"name":"web_search","arguments":{"query":"news"}}</tool_call>', 1],
    ['<tool_call>not JSON</tool_call>', 0],
    ['<tool_call>{"name":"other","arguments":{}}</tool_call>', 0],
    ['<tool_call>{"name":"web_search","arguments":{"query":""}}</tool_call>', 0],
    ['<tool_call>{"name":"web_search"', 0],
  ]) {
    let searches = 0
    let completions = 0
    const api = await loadApi({
      fetch: async (url) => {
        if (url === 'https://mcp.exa.ai/mcp') {
          searches++
          return exaResponse()
        }
        completions++
        return completions === 1
          ? response(Array.from(`Before ${markup} after`).map((content) => ({ content })))
          : response([{ content: 'Final answer.' }])
      },
    })
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', await makeRequest(api), signal())
    )
    assert.equal(searches, expectedSearches)
    assert.doesNotMatch(text(events), /tool_call|"name"|not JSON/)
    assert.match(text(events), /Before/)
    if (expectedSearches) {
      assert.match(text(events), /Final answer/)
    }
  }
})

test('search is off by default and search rounds are bounded even if the model keeps calling', async () => {
  let completions = 0
  let searches = 0
  let finalBody
  const api = await loadApi({
    fetch: async (url, init) => {
      if (url === 'https://mcp.exa.ai/mcp') {
        searches++
        return exaResponse()
      }
      completions++
      finalBody = JSON.parse(init.body)
      return response([call()], 'tool_calls')
    },
  })
  await collect(
    api.streamOpenaiMessage(
      'https://gateway.test/v1',
      'key',
      await makeRequest(api, false),
      signal()
    )
  )
  assert.equal(searches, 0)
  assert.equal(completions, 1)
  completions = 0
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', await makeRequest(api), signal())
  )
  assert.equal(searches, 3)
  assert.equal(completions, 4)
  assert.equal(finalBody.tool_choice, 'none')
  assert.equal(finalBody.tools, undefined)
  assert.match(text(events), /搜索工具调用轮数超过上限（3 轮）/)
  assert.equal(events.at(-1).type, 'message_stop')
})
