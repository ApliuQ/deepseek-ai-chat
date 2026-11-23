import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, loadApi, sseBody } from './testHarness.mjs'

const signal = () => new AbortController().signal
const response = (deltas, finish = 'stop') =>
  new Response(
    sseBody(
      [
        ...deltas.map((delta) => ({ choices: [{ delta }] })),
        { choices: [{ delta: {}, finish_reason: finish }] },
        '[DONE]',
      ]
        .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
        .join('')
    ),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const answer = (events) =>
  events
    .map(
      (event) =>
        event.delta?.text ?? (event.content_block?.type === 'text' ? event.content_block.text : '')
    )
    .join('')
const request = (api, search) =>
  api.buildOpenaiRequest(
    [{ role: 'user', content: 'Search for current news' }],
    'model',
    false,
    search,
    async () => undefined,
    signal()
  )

test('hosted search sends web_search_options only when enabled and preserves upstream citations', async () => {
  for (const search of [true, false]) {
    const calls = []
    const api = await loadApi({
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, body })
        assert.equal(url, 'https://gateway.test/v1/chat/completions')
        assert.equal(body.tools, undefined)
        assert.equal(body.tool_choice, undefined)
        return response([
          {
            content: 'Current news.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: { url: 'https://example.com/news', title: 'Source' },
              },
            ],
          },
        ])
      },
    })
    const events = await collect(
      api.streamChatMessage('https://gateway.test/v1', 'key', await request(api, search), signal())
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.reasoning_effort, 'none')
    assert.deepEqual(calls[0].body.web_search_options, search ? {} : undefined)
    assert.equal(answer(events), 'Current news.')
    assert.equal(
      events.find((event) => event.delta?.citation)?.delta.citation.url,
      'https://example.com/news'
    )
    assert.equal(events.filter((event) => event.type === 'message_start').length, 1)
    assert.equal(events.filter((event) => event.type === 'message_stop').length, 1)
  }
})

test('split pseudo-tool markup is stripped, never executed, and cannot leave an empty reply', async () => {
  for (const search of [true, false]) {
    for (const markup of [
      '<tool_call>{"name":"web_search","arguments":{"query":"news"}}</tool_call>',
      '<tool_call>not JSON</tool_call>',
      '<tool_call>{"name":"other"}</tool_call>',
      '<tool_call>unfinished',
      '<tool_ca',
      '   ',
      '',
    ]) {
      let calls = 0
      const api = await loadApi({
        fetch: async (url) => {
          calls++
          assert.equal(url, 'https://gateway.test/v1/chat/completions')
          return response([
            { reasoning_content: 'Need a search.' },
            ...Array.from(markup, (content) => ({ content })),
          ])
        },
      })
      const events = await collect(
        api.streamChatMessage(
          'https://gateway.test/v1',
          'key',
          await request(api, search),
          signal()
        )
      )
      assert.equal(calls, 1)
      assert.match(answer(events), /模型未返回可显示的回答/)
      assert.doesNotMatch(answer(events), /当前模型不支持联网搜索/)
      assert.doesNotMatch(answer(events), /tool_call|not JSON|"name"/)
    }
  }
})

test('stripping preserves surrounding answers, including multiple split markup blocks', async () => {
  const api = await loadApi({
    fetch: async () =>
      response(
        Array.from(
          'Before <tool_call>one</tool_call> after <tool_call>two</tool_call>.',
          (content) => ({ content })
        )
      ),
  })
  const events = await collect(
    api.streamChatMessage('https://gateway.test/v1', 'key', await request(api, true), signal())
  )
  assert.equal(answer(events), 'Before  after .')
})

test('unexpected structured calls are not executed and finish with a readable note', async () => {
  let calls = 0
  const api = await loadApi({
    fetch: async (url) => {
      calls++
      assert.equal(url, 'https://gateway.test/v1/chat/completions')
      return response(
        [
          {
            tool_calls: [
              {
                index: 0,
                id: 'unexpected',
                function: { name: 'web_search', arguments: '{"query":"news"}' },
              },
            ],
          },
        ],
        'tool_calls'
      )
    },
  })
  const events = await collect(
    api.streamChatMessage('https://gateway.test/v1', 'key', await request(api, true), signal())
  )
  assert.equal(calls, 1)
  assert.match(answer(events), /模型未返回可显示的回答/)
  assert.equal(events.at(-2).delta.stop_reason, 'end_turn')
})

test('hosted search HTTP and malformed-response errors surface without another request', async () => {
  for (const result of [
    () => Response.json({ error: { message: 'Search unsupported' } }, { status: 403 }),
    () => Response.json({ choices: [] }),
  ]) {
    let calls = 0
    const api = await loadApi({
      fetch: async () => {
        calls++
        return result()
      },
    })
    await assert.rejects(
      collect(
        api.streamChatMessage('https://gateway.test/v1', 'key', await request(api, true), signal())
      )
    )
    assert.equal(calls, 1)
  }
})
