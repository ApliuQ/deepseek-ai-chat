import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { collect, loadApi, sseBody } from '../src/services/api/testHarness.mjs'

const baseline = execFileSync('git', ['show', 'main:src/services/api/client.ts'], {
  encoding: 'utf8',
})
const capture = async (clientSource, body) => {
  let captured
  const api = await loadApi({
    clientSource,
    fetch: async (url, init) => {
      captured = { url, method: init.method, headers: init.headers, body: init.body }
      return new Response(sseBody('data: {"type":"message_stop"}\n\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  await collect(api.streamMessage('test-key', body, new AbortController().signal))
  return JSON.parse(JSON.stringify(captured))
}
for (const thinking of [false, true]) {
  for (const search of [false, true]) {
    for (const file of [false, true]) {
      const body = {
        model: 'deepseek-flash',
        system: '该助手为DeepSeek，由深度求索公司创造。',
        messages: [
          { role: 'latest_reminder', content: '2026-01-01,Thursday,,Web,English' },
          {
            role: 'user',
            content: file
              ? [
                  { type: 'image', source: { type: 'file', file_id: 'file-test' } },
                  { type: 'text', text: 'question' },
                ]
              : 'question',
          },
        ],
        thinking: { type: thinking ? 'enabled' : 'disabled' },
        safety_check: { level: 'high' },
        tools: [
          { type: 'deepseek_read_url', name: 'deepseek_read_url' },
          ...(search ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }] : []),
        ],
        title: { enabled: true },
      }
      assert.deepEqual(await capture(undefined, body), await capture(baseline, body))
    }
  }
}
process.stdout.write(
  'PASS DeepSeek parity against main: 8 text/file × thinking × search cases; URL, method, headers and serialized body byte-for-byte equal\n'
)
