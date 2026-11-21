import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { loadApi, collect, sseBody } from './testHarness.mjs'

const loadChat = async () => {
  const context = vm.createContext({ Intl, Date })
  const modules = new Map()
  const compile = (url) => {
    if (!modules.has(url.href)) {
      modules.set(
        url.href,
        new vm.SourceTextModule(
          stripTypeScriptTypes(readFileSync(url, 'utf8'), { mode: 'transform' }),
          { context, identifier: url.href }
        )
      )
    }
    return modules.get(url.href)
  }
  const link = (specifier, parent) =>
    specifier.includes('/i18n/')
      ? new vm.SyntheticModule(
          ['translate'],
          function () {
            this.setExport('translate', () => 'English')
          },
          { context }
        )
      : compile(new URL(specifier.replace(/\.js$/, '.ts'), parent.identifier))
  const reply = compile(new URL('../chat/reply.ts', import.meta.url))
  const reminder = compile(new URL('../chat/latestReminder.ts', import.meta.url))
  await reply.link(link)
  await reply.evaluate()
  await reminder.link(link)
  await reminder.evaluate()
  return { ...reply.namespace, ...reminder.namespace }
}
const storage = (values) => ({
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
})
const question = { id: 'q', role: 'user', content: 'Question', files: [], createdAt: 1 }
const snapshot = '2026-01-01,Thursday,北京,Web,English'
const reply = {
  id: 'a',
  role: 'assistant',
  status: 'done',
  prefix: true,
  blocks: [{ type: 'text', text: 'Answer' }],
  latestReminder: snapshot,
}

test('location selection and clearing persist across reload; invalid values remain empty', async () => {
  const values = new Map()
  const api = await loadApi({ storage: storage(values) })
  api.setLocation({ region: 'CN', province: '110000' })
  assert.equal(JSON.parse(values.get('chat-demo:location')).province, '110000')
  const restored = await loadApi({ storage: storage(values) })
  assert.equal(restored.useSettings.getState().location.province, '110000')
  restored.setLocation(null)
  assert.equal(restored.useSettings.getState().location, null)
  assert.equal(values.has('chat-demo:location'), false)
  const reloaded = await loadApi({ storage: storage(values) })
  assert.equal(reloaded.useSettings.getState().location, null)
  reloaded.setLocation(null)
  reloaded.setLocation({ region: 'invalid' })
  assert.equal(reloaded.useSettings.getState().location, null)
  assert.equal(values.has('chat-demo:location'), false)
})

test('empty location removes historical and continuation reminder locations from both API formats', async () => {
  const chat = await loadChat()
  const current = chat.createLatestReminder(
    { locale: 'en-US', location: null },
    new Date(2026, 0, 2)
  )
  assert.equal(current.split(',')[2], '')
  const present = chat.createLatestReminder(
    { locale: 'zh-CN', location: { region: 'CN', province: '110000' } },
    new Date(2026, 0, 2)
  )
  assert.ok(present.includes('北京'))
  const unchanged = chat.toRequestMessages(
    [question, reply],
    question,
    reply,
    false,
    snapshot,
    false
  )
  assert.ok(JSON.stringify(unchanged).includes('北京'))
  assert.equal(reply.latestReminder, snapshot)
  for (const prefix of [undefined, reply]) {
    const messages = chat.toRequestMessages(
      [question, reply],
      question,
      prefix,
      false,
      prefix ? snapshot : current,
      true
    )
    assert.ok(!JSON.stringify(messages).includes('北京'))
    assert.ok(
      messages
        .filter((m) => m.role === 'latest_reminder')
        .every((m) => m.content.split(',')[2] === '')
    )
    let captured
    const api = await loadApi({
      fetch: async (url, init) => {
        captured = JSON.parse(init.body)
        return new Response(sseBody('data: {"type":"message_stop"}\n\n'), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })
    await collect(
      api.streamMessage('key', { model: 'deepseek-flash', messages }, new AbortController().signal)
    )
    assert.ok(!JSON.stringify(captured).includes('北京'))
    assert.ok(captured.messages.some((m) => m.role === 'latest_reminder'))
    const custom = await api.buildOpenaiRequest(
      messages,
      'model',
      false,
      false,
      async () => undefined,
      new AbortController().signal
    )
    assert.ok(!JSON.stringify(custom).includes('北京'))
    assert.ok(
      custom.messages
        .filter((m) => m.role === 'system')
        .some((m) => m.content === messages.find((m) => m.role === 'latest_reminder').content)
    )
    assert.ok(!JSON.stringify(api.buildResponsesRequest(custom)).includes('北京'))
  }
  assert.equal(reply.latestReminder, snapshot)
})

test('clearing handles region names with commas and ignores malformed legacy snapshots', async () => {
  const { toRequestMessages } = await loadChat()
  for (const reminder of [
    undefined,
    'malformed location',
    '2026-01-01,Thursday,Bonaire, Sint Eustatius and Saba,Web,English',
  ]) {
    const messages = toRequestMessages([], question, undefined, false, reminder, true)
    assert.ok(!JSON.stringify(messages).includes('malformed location'))
    assert.ok(!JSON.stringify(messages).includes('Bonaire'))
    const note = messages.find((m) => m.role === 'latest_reminder')
    if (reminder?.includes('Bonaire')) {
      assert.equal(note.content, '2026-01-01,Thursday,,Web,English')
    } else {
      assert.equal(note, undefined)
    }
  }
})
