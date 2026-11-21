import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, loadApi, sseBody } from './testHarness.mjs'

const signal = () => new AbortController().signal
const storage = () => {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}
const sse = (frames) =>
  new Response(sseBody(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
const completed = {
  type: 'response.completed',
  response: {
    output: [],
    usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 2 }, output_tokens: 4 },
  },
}
const search = {
  type: 'response.output_item.done',
  item: {
    type: 'web_search_call',
    status: 'completed',
    id: 'ws_1',
    action: {
      type: 'search',
      query: 'news',
      sources: [{ url: 'https://example.com', title: 'News' }],
    },
  },
}
const citation = {
  type: 'response.output_text.annotation.added',
  annotation: { type: 'url_citation', url: 'https://example.com', title: 'News' },
}

test('capabilities require evidence, probe in order and cache each root/model with TTL', async () => {
  for (const method of ['chat', 'responses', 'client']) {
    const calls = []
    const store = storage()
    const api = await loadApi({
      storage: store,
      fetch: async (url, init) => {
        calls.push(url)
        const body = JSON.parse(init.body)
        assert.equal(body.stream, false)
        return Response.json(
          url.endsWith('/responses')
            ? {
                output:
                  method === 'responses' ? [{ type: 'web_search_call', status: 'completed' }] : [],
              }
            : {
                choices: [
                  {
                    message: {
                      content: 'I searched!',
                      annotations:
                        method === 'chat'
                          ? [{ type: 'url_citation', url_citation: { url: 'https://example.com' } }]
                          : [],
                    },
                  },
                ],
              }
        )
      },
    })
    const detect = (model) =>
      api.detectSearchMethod('https://GATEWAY.test/v1/', 'secret', model, signal())
    assert.equal(await detect('one'), method)
    assert.equal(await detect('one'), method)
    assert.equal(calls.length, method === 'chat' ? 1 : 2)
    const key = api.searchCapabilityKey('https://gateway.test/v1', 'one')
    assert.equal(JSON.parse(store.getItem(key)).method, method)
    assert.ok(!store.getItem(key).includes('secret'))
    store.setItem(key, JSON.stringify({ method, expires: Date.now() - 1 }))
    await detect('one')
    await detect('two')
    assert.equal(calls.length, method === 'chat' ? 3 : 6)
    api.invalidateSearchMethod('https://gateway.test/v1', 'one')
    assert.equal(store.getItem(key), null)
  }
})

test('concurrent probes dedupe; errors, 404 and incomplete search are unsupported; corrupt or denied storage is safe', async () => {
  let calls = 0
  const api = await loadApi({
    storage: {
      getItem: () => '{broken',
      setItem: () => {
        throw Error('denied')
      },
    },
    fetch: async (url) => {
      calls++
      return url.endsWith('/responses')
        ? Response.json({ output: [{ type: 'web_search_call', status: 'in_progress' }] })
        : new Response('', { status: 404 })
    },
  })
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 4 }, () =>
        api.detectSearchMethod('https://gateway.test/v1', 'key', 'm', signal())
      )
    ),
    ['client', 'client', 'client', 'client']
  )
  assert.equal(calls, 2)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    api.detectSearchMethod('https://gateway.test/v1', 'key', 'm', controller.signal)
  )
})

test('Responses request maps system, reminder, history, extracted text and images; thinking uses reasoning.effort', async () => {
  const api = await loadApi()
  for (const thinking of [true, false]) {
    const body = await api.buildOpenaiRequest(
      [
        { role: 'latest_reminder', content: 'reminder' },
        { role: 'user', content: 'history' },
        { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'question' },
            { type: 'document', source: { file_id: 'file' } },
            { type: 'image', source: { file_id: 'image' } },
          ],
        },
      ],
      'model',
      thinking,
      true,
      async (id) => ({
        blob: new Blob([id === 'image' ? 'image' : 'secret value 4821'], {
          type: id === 'image' ? 'image/png' : 'text/plain',
        }),
        name: id === 'image' ? 'image.png' : 'note.txt',
        isImage: id === 'image',
      }),
      signal()
    )
    const result = api.buildResponsesRequest(body)
    assert.equal(result.reasoning.effort, thinking ? 'high' : 'none')
    assert.deepEqual(JSON.parse(JSON.stringify(result.tools)), [{ type: 'web_search' }])
    assert.equal(result.input[1].content[0].text, 'reminder')
    assert.equal(result.input[3].content[0].type, 'output_text')
    assert.ok(
      result.input[4].content.some(
        (part) => part.type === 'input_text' && part.text.includes('4821')
      )
    )
    assert.ok(
      result.input[4].content.some(
        (part) => part.type === 'input_image' && part.image_url.startsWith('data:image/png;base64,')
      )
    )
  }
})

test('Responses mapper streams reasoning, text, search results, citations and usage without duplicate search items', async () => {
  const api = await loadApi()
  const events = await collect(
    api.responsesStreamEvents(
      sse([
        { type: 'response.created', response: { id: 'r' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
        search,
        search,
        { type: 'response.output_text.delta', delta: 'Answer<tool_call>hidden</tool_call>' },
        citation,
        citation,
        completed,
      ]).body,
      'model',
      signal()
    )
  )
  assert.equal(events.filter((e) => e.content_block?.type === 'server_tool_use').length, 1)
  assert.equal(
    events.find((e) => e.content_block?.type === 'web_search_tool_result').content_block.content[0]
      .url,
    'https://example.com'
  )
  assert.equal(events.filter((e) => e.delta?.citation).length, 1)
  assert.equal(events.find((e) => e.delta?.thinking).delta.thinking, 'Thinking')
  assert.equal(events.find((e) => e.delta?.text).delta.text, 'Answer')
  assert.equal(events.find((e) => e.type === 'message_delta').usage.input_tokens, 7)
})

test('Responses empty/error/interrupted streams are readable or fail; final-item citations are mapped', async () => {
  const api = await loadApi()
  const empty = await collect(api.responsesStreamEvents(sse([completed]).body, 'm', signal()))
  assert.match(empty.find((e) => e.content_block?.type === 'text').content_block.text, /未返回/)
  await assert.rejects(
    collect(
      api.responsesStreamEvents(
        sse([{ type: 'response.failed', response: { error: { message: 'broken' } } }]).body,
        'm',
        signal()
      )
    ),
    /broken/
  )
  await assert.rejects(
    collect(api.responsesStreamEvents(sse([]).body, 'm', signal())),
    /Incomplete/
  )
  const final = await collect(
    api.responsesStreamEvents(
      sse([
        {
          ...completed,
          response: {
            output: [{ type: 'message', content: [{ annotations: [citation.annotation] }] }],
          },
        },
      ]).body,
      'm',
      signal()
    )
  )
  assert.ok(final.some((e) => e.delta?.citation))
})

test('cached Chat runtime failure invalidates cache and falls through to streamed Responses', async () => {
  const store = storage()
  const calls = []
  const api = await loadApi({
    storage: store,
    fetch: async (url, init) => {
      calls.push(url)
      if (url.endsWith('/chat/completions')) {
        return new Response('unsupported', { status: 400 })
      }
      assert.equal(JSON.parse(init.body).stream, true)
      return sse([
        search,
        { type: 'response.output_text.delta', delta: 'Current news' },
        citation,
        completed,
      ])
    },
  })
  const key = api.searchCapabilityKey('https://gateway.test/v1', 'm')
  store.setItem(key, JSON.stringify({ method: 'chat', expires: Date.now() + 60000 }))
  const body = await api.buildOpenaiRequest(
    [{ role: 'user', content: 'news' }],
    'm',
    false,
    true,
    async () => undefined,
    signal()
  )
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
  )
  assert.equal(calls.length, 2)
  assert.equal(store.getItem(key), null)
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
  assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  assert.ok(events.some((e) => e.delta?.citation))
})

test('Responses failure falls through to client; Exa/Jina 429 always shows the required note', async () => {
  for (const name of ['web_search', 'fetch_url']) {
    const store = storage()
    let chats = 0
    const api = await loadApi({
      storage: store,
      fetch: async (url, init) => {
        if (url.endsWith('/responses')) {
          return new Response('missing', { status: 404 })
        }
        if (!url.endsWith('/chat/completions')) {
          assert.equal(new Headers(init.headers).has('Authorization'), false)
          return new Response('rate limited', { status: 429 })
        }
        chats++
        const chunk =
          chats === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    function: {
                      name,
                      arguments: JSON.stringify(
                        name === 'web_search' ? { query: 'news' } : { url: 'https://example.com' }
                      ),
                    },
                  },
                ],
              }
            : { content: 'Here is what I know.' }
        return new Response(
          sseBody(
            [
              { choices: [{ delta: chunk }] },
              { choices: [{ delta: {}, finish_reason: chats === 1 ? 'tool_calls' : 'stop' }] },
            ]
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join('') + 'data: [DONE]\n\n'
          ),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      },
    })
    store.setItem(
      api.searchCapabilityKey('https://gateway.test/v1', 'm'),
      JSON.stringify({ method: 'responses', expires: Date.now() + 60000 })
    )
    const body = await api.buildOpenaiRequest(
      [{ role: 'user', content: 'news' }],
      'm',
      false,
      true,
      async () => undefined,
      signal()
    )
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
    )
    const text = events.map((e) => e.delta?.text ?? e.content_block?.text ?? '').join('')
    assert.match(text, /当前模型不支持联网搜索/)
    assert.match(text, /429/)
    assert.match(text, /Here is what I know/)
    assert.equal(chats, 2)
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  }
})

test('mid-stream hosted failure closes partial blocks before falling through with one lifecycle', async () => {
  const store = storage()
  const api = await loadApi({
    storage: store,
    fetch: async (url) =>
      url.endsWith('/chat/completions')
        ? sse([
            { choices: [{ delta: { content: 'Partial answer' } }] },
            { error: { message: 'failed' } },
          ])
        : sse([
            search,
            { type: 'response.output_text.delta', delta: 'Searched answer' },
            completed,
          ]),
  })
  store.setItem(
    api.searchCapabilityKey('https://gateway.test/v1', 'm'),
    JSON.stringify({ method: 'chat', expires: Date.now() + 60000 })
  )
  const body = await api.buildOpenaiRequest(
    [{ role: 'user', content: 'news' }],
    'm',
    false,
    true,
    async () => undefined,
    signal()
  )
  const events = await collect(
    api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
  )
  const starts = events.filter((e) => e.type === 'content_block_start').map((e) => e.index)
  assert.equal(new Set(starts).size, starts.length)
  assert.deepEqual(
    events.filter((e) => e.type === 'content_block_stop').map((e) => e.index),
    starts
  )
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
  assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
})

test('Responses runtime citations without completed search fall through; failed client requests invalidate cache', async () => {
  const store = storage()
  let chats = 0
  const api = await loadApi({
    storage: store,
    fetch: async (url) => {
      if (url.endsWith('/responses')) {
        return sse([citation, completed])
      }
      chats++
      return new Response('unavailable', { status: 503 })
    },
  })
  const key = api.searchCapabilityKey('https://gateway.test/v1', 'm')
  const body = await api.buildOpenaiRequest(
    [{ role: 'user', content: 'news' }],
    'm',
    false,
    true,
    async () => undefined,
    signal()
  )
  for (const method of ['responses', 'client']) {
    store.setItem(key, JSON.stringify({ method, expires: Date.now() + 60000 }))
    const events = await collect(
      api.streamOpenaiMessage('https://gateway.test/v1', 'key', body, signal())
    )
    assert.equal(store.getItem(key), null)
    assert.match(events.map((e) => e.content_block?.text ?? '').join(''), /当前模型不支持联网搜索/)
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1)
  }
  assert.equal(chats, 2)
})
