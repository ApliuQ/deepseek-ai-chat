import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

const load = async ({
  saved = {},
  search = '',
  embedded = false,
  ancestor,
  referrer = '',
} = {}) => {
  const cache = new Map(Object.entries(saved))
  const calls = []
  let response = new Response('{}')
  const window = { location: { search, ancestorOrigins: ancestor ? [ancestor] : [] } }
  window.self = window
  window.top = embedded ? {} : window
  const context = vm.createContext({
    __API_ORIGIN__: 'https://api.deepseek.com',
    window,
    document: { referrer },
    URL,
    URLSearchParams,
    navigator: { language: 'en-US' },
    localStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
    },
    fetch: async (...args) => {
      calls.push(args)
      return response
    },
  })
  const stub = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) {
          this.setExport(key, value)
        }
      },
      { context }
    )
  const compile = (path) =>
    new vm.SourceTextModule(
      stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        mode: 'transform',
      }),
      { context }
    )
  const settings = compile('../settings.ts')
  await settings.link((specifier) => {
    if (specifier === 'zustand') {
      return stub({
        create: (init) => {
          const store = () => {}
          let state = init()
          store.getState = () => state
          store.setState = (next) => {
            state = { ...state, ...next }
          }
          return store
        },
      })
    }
    return stub({ normalizeLocation: (value) => value })
  })
  await settings.evaluate()
  const client = compile('./client.ts')
  await client.link((specifier) => {
    if (specifier.endsWith('/settings.js')) {
      return settings
    }
    if (specifier.includes('i18n')) {
      return stub({ translate: (key) => key })
    }
    if (specifier.includes('resizeUploadImage')) {
      return stub({ resizeUploadImage: (file) => file })
    }
    if (specifier.includes('parseEvent')) {
      return stub({ readMessageEvent: (value) => value })
    }
    return stub({ readServerSentEvents: async function* () {} })
  })
  await client.evaluate()
  return {
    ...settings.namespace,
    ...client.namespace,
    cache,
    calls,
    respond: (value) => {
      response = value
    },
  }
}

test('defaults, normalized providers and versioned roots', async () => {
  const api = await load()
  assert.equal(api.useSettings.getState().baseUrl, 'https://api.deepseek.com')
  for (const suffix of ['', '/', '/v1', '/anthropic/']) {
    assert.equal(api.getApiProvider(`https://api.deepseek.com${suffix}`), 'deepseek')
  }
  assert.equal(api.getApiProvider('https://other.test'), 'openai')
  assert.equal(api.getOpenaiRoot(' https://other.test/// '), 'https://other.test/v1')
  assert.equal(api.getOpenaiRoot('https://other.test/api/v2/'), 'https://other.test/api/v2')
})

test('iframe origins, referrer fallback, query aliases and cache precedence', async () => {
  const cases = [
    [{ embedded: true, ancestor: 'https://parent.test' }, 'https://parent.test/v1'],
    [{ embedded: true, referrer: 'https://fallback.test/page' }, 'https://fallback.test/v1'],
    [{ embedded: true }, 'https://api.deepseek.com'],
    [{ search: '?base_url=https%3A%2F%2Fquery.test%2F' }, 'https://query.test'],
    [
      {
        search: '?baseUrl=https%3A%2F%2Fquery.test',
        saved: { 'chat-demo:base-url': 'https://cached.test' },
      },
      'https://cached.test',
    ],
  ]
  for (const [options, expected] of cases) {
    assert.equal((await load(options)).useSettings.getState().baseUrl, expected)
  }
})

test('verification uses live roots and Bearer auth; model choice is persisted', async () => {
  const api = await load()
  api.respond(Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))
  assert.deepEqual(Array.from(await api.verifyApiKey('key')), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(api.calls[0][0], 'https://api.deepseek.com/models')
  assert.equal(api.calls[0][1].headers.Authorization, 'Bearer key')
  api.respond(Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
  const ids = await api.verifyApiKey('other', 'https://other.test/')
  assert.deepEqual(Array.from(ids), ['model-a', 'model-b'])
  assert.equal(api.calls[1][0], 'https://other.test/v1/models')
  api.setConnection('other', 'https://other.test/', ids)
  assert.equal(api.cache.get('chat-demo:base-url'), 'https://other.test')
  assert.equal(api.cache.get('chat-demo:openai-model'), 'model-a')
  api.setOpenaiModel('model-b')
  assert.equal(api.cache.get('chat-demo:openai-model'), 'model-b')
  api.setConnection('other', 'https://other.test', ids)
  assert.equal(api.useSettings.getState().openaiModel, 'model-b')
})

test('empty, malformed and rejected model lists do not save a connection', async () => {
  const api = await load()
  for (const baseUrl of ['https://api.deepseek.com', 'https://other.test']) {
    for (const body of [{ data: [] }, {}, { data: [{ id: 1 }] }]) {
      api.respond(Response.json(body))
      await assert.rejects(api.verifyApiKey('bad', baseUrl), { kind: 'protocol' })
    }
    api.respond(new Response('not JSON'))
    await assert.rejects(api.verifyApiKey('bad', baseUrl), { kind: 'protocol' })
  }
  api.respond(new Response('unauthorized', { status: 401 }))
  await assert.rejects(api.verifyApiKey('bad', 'https://other.test'), { status: 401 })
  assert.equal(api.cache.size, 0)
})

test('default URL ignores cached and query URLs, derives iframe parents without saving', async () => {
  for (const [context, expected] of [
    [{}, 'https://api.deepseek.com'],
    [{ embedded: true, ancestor: 'https://parent.test:8091' }, 'https://parent.test:8091/v1'],
    [{ embedded: true, referrer: 'https://referrer.test/iframe' }, 'https://referrer.test/v1'],
    [{ embedded: true, referrer: 'invalid' }, 'https://api.deepseek.com'],
  ]) {
    const api = await load({
      ...context,
      search: '?baseUrl=https%3A%2F%2Fquery.test',
      saved: { 'chat-demo:base-url': 'https://cached.test' },
    })
    assert.equal(api.getDefaultBaseUrl(), expected)
    assert.equal(api.cache.get('chat-demo:base-url'), 'https://cached.test')
    assert.equal(api.useSettings.getState().baseUrl, 'https://cached.test')
    assert.equal(api.calls.length, 0)
  }
})

test('DeepSeek selection defaults, persists separately and falls back when absent from the list', async () => {
  const api = await load({ saved: { 'chat-demo:openai-model': 'openai-model' } })
  assert.equal(api.useSettings.getState().deepseekModel, 'deepseek-flash')
  api.setDeepseekModel('deepseek-v4-pro')
  assert.equal(api.cache.get('chat-demo:deepseek-model'), 'deepseek-v4-pro')
  api.setConnection('key', 'https://api.deepseek.com', ['deepseek-v4-pro', 'deepseek-flash'])
  assert.equal(api.useSettings.getState().deepseekModel, 'deepseek-v4-pro')
  assert.equal(api.useSettings.getState().openaiModel, 'openai-model')
  assert.equal(api.cache.get('chat-demo:openai-model'), 'openai-model')
  const restored = await load({ saved: Object.fromEntries(api.cache) })
  assert.equal(restored.useSettings.getState().deepseekModel, 'deepseek-v4-pro')
  restored.setDeepseekModels(['deepseek-flash'])
  assert.equal(restored.useSettings.getState().deepseekModel, 'deepseek-flash')
  assert.equal(restored.cache.get('chat-demo:deepseek-model'), 'deepseek-flash')
  restored.setDeepseekModel('unavailable')
  restored.setDeepseekModels(['another-model'])
  assert.equal(restored.useSettings.getState().deepseekModel, 'deepseek-flash')
})
