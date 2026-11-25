import assert from 'node:assert/strict'
import test from 'node:test'
import { loadApi } from './testHarness.mjs'

test('models are sorted naturally without case sensitivity and selection is retained', async () => {
  const api = await loadApi()
  assert.deepEqual(Array.from(api.sortModelNames(['z', 'model10', 'Model2', 'a', 'z'])), [
    'a',
    'Model2',
    'model10',
    'z',
  ])
  api.setConnection('key', 'https://gateway.test', ['z', 'a'])
  assert.equal(api.useSettings.getState().openaiModel, 'a')
  api.setOpenaiModel('z')
  api.setOpenaiModels(['b', 'z'])
  assert.equal(api.useSettings.getState().openaiModel, 'z')
  api.setOpenaiModels(['c', 'b'])
  assert.equal(api.useSettings.getState().openaiModel, 'b')
  api.setOpenaiModels([])
  assert.equal(api.useSettings.getState().openaiModel, '')
})

test('custom models hide image models and follow the vendor group order', async () => {
  const api = await loadApi()
  assert.deepEqual(
    Array.from(
      api.sortOpenaiModelNames([
        'qwen-max',
        'glm-4.6',
        'deepseek-v4.1-flash-1017',
        'swe-2-flash',
        'gemini-3.8-flash',
        'claude-haiku-5-5',
        'Claude-Opus-5',
        'grok-4.7',
        'gpt-6.2-sol',
        'gpt-6-luna',
        'gpt-image-2.6-sunburst',
        'GPT-IMAGE-2',
        'abc-model',
        'openrouter/gpt-5',
      ])
    ),
    [
      'gpt-6-luna',
      'gpt-6.2-sol',
      'openrouter/gpt-5',
      'grok-4.7',
      'claude-haiku-5-5',
      'Claude-Opus-5',
      'gemini-3.8-flash',
      'swe-2-flash',
      'deepseek-v4.1-flash-1017',
      'glm-4.6',
      'abc-model',
      'qwen-max',
    ]
  )
  api.setConnection('key', 'https://gateway.test', ['gpt-image-2', 'zeta', 'grok-4'])
  assert.deepEqual(Array.from(api.useSettings.getState().openaiModels), ['grok-4', 'zeta'])
  assert.equal(api.useSettings.getState().openaiModel, 'grok-4')
})

test('refresh fills an empty list, deduplicates requests and reuses a fresh list', async () => {
  const calls = []
  const api = await loadApi({
    fetch: async (...args) => {
      calls.push(args)
      return Response.json({ data: [{ id: 'z' }, { id: 'a' }] })
    },
  })
  api.useSettings.setState({
    baseUrl: 'https://gateway.test',
    apiKey: 'cached-key',
    openaiModel: 'z',
  })
  await Promise.all([api.refreshModels(), api.refreshModels()])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://gateway.test/v1/models')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer cached-key')
  assert.deepEqual(Array.from(api.useSettings.getState().openaiModels), ['a', 'z'])
  assert.equal(api.useSettings.getState().openaiModel, 'z')
  await api.refreshModels()
  assert.equal(calls.length, 1)
  api.useSettings.setState({ openaiModels: [] })
  await api.refreshModels()
  assert.equal(calls.length, 2)
  api.useSettings.setState({ apiKey: 'new-key' })
  await api.refreshModels()
  assert.equal(calls.length, 3)
})

test('refresh skips missing keys, rejects errors and ignores outdated connections', async () => {
  let resolve
  let calls = 0
  const api = await loadApi({
    fetch: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  await api.refreshModels()
  api.useSettings.setState({ baseUrl: 'https://gateway.test' })
  await api.refreshModels()
  assert.equal(calls, 0)
  api.useSettings.setState({ apiKey: 'key' })
  const first = api.refreshModels()
  api.useSettings.setState({ baseUrl: 'https://other.test' })
  resolve(Response.json({ data: [{ id: 'outdated' }] }))
  await first
  assert.equal(api.useSettings.getState().openaiModels.length, 0)
  const denied = api.refreshModels()
  resolve(Response.json({ error: { message: 'denied' } }, { status: 403 }))
  await assert.rejects(denied, { status: 403 })
  const empty = api.refreshModels()
  resolve(Response.json({ data: [] }))
  await assert.rejects(empty, { kind: 'protocol' })
  const retry = api.refreshModels()
  resolve(Response.json({ data: [{ id: 'recovered' }] }))
  await retry
  assert.equal(api.useSettings.getState().openaiModel, 'recovered')
})

test('refresh revalidates a populated list on startup', async () => {
  let calls = 0
  const api = await loadApi({
    fetch: async () => {
      calls++
      return Response.json({ data: [{ id: 'available' }] })
    },
  })
  api.useSettings.setState({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'key',
    openaiModels: ['old-model'],
    openaiModel: 'old-model',
  })
  await api.refreshModels()
  assert.equal(calls, 1)
  assert.equal(api.useSettings.getState().openaiModel, 'available')
})

test('startup validation is silent on success and shares pending/fresh model refreshes for both providers', async () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://gateway.test/v1']) {
    let calls = 0
    const api = await loadApi({
      fetch: async () => {
        calls++
        return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] })
      },
    })
    api.useSettings.setState({ baseUrl, apiKey: 'cached-key' })
    await Promise.all([api.validateCachedConnection(), api.refreshModels()])
    await api.refreshModels()
    assert.equal(calls, 1)
    assert.equal(api.useSettingsDialog.getState().open, false)
    const state = api.useSettings.getState()
    const models = baseUrl.includes('gateway') ? state.openaiModels : state.deepseekModels
    assert.deepEqual(Array.from(models), ['deepseek-flash', 'deepseek-v4-pro'])
    if (!baseUrl.includes('gateway')) {
      assert.equal(state.deepseekModel, 'deepseek-flash')
      api.setDeepseekModel('deepseek-v4-pro')
      api.setDeepseekModels(['deepseek-v4-pro'])
      assert.equal(api.useSettings.getState().deepseekModel, 'deepseek-v4-pro')
      api.setDeepseekModels(['deepseek-flash'])
      assert.equal(api.useSettings.getState().deepseekModel, 'deepseek-flash')
    }
  }
})

test('startup failures open connection settings with the readable verification error', async () => {
  const cases = [
    [
      () => {
        throw new TypeError('offline')
      },
      'network',
      undefined,
    ],
    [() => Response.json({ error: { message: 'bad cached key' } }, { status: 401 }), 'http', 401],
    [() => Response.json({ error: { message: 'forbidden model' } }, { status: 403 }), 'http', 403],
    [() => Response.json({}), 'protocol', undefined],
    [() => Response.json({ data: [] }), 'protocol', undefined],
    [() => new Response('not JSON'), 'protocol', undefined],
  ]
  for (const [respond, kind, status] of cases) {
    let calls = 0
    const api = await loadApi({
      fetch: async () => {
        calls++
        return respond()
      },
    })
    api.useSettings.setState({ baseUrl: 'https://gateway.test', apiKey: 'bad-cached-key' })
    await Promise.all([api.validateCachedConnection(), api.refreshModels().catch(() => {})])
    assert.equal(calls, 1)
    const dialog = api.useSettingsDialog.getState()
    assert.equal(dialog.open, true)
    assert.equal(dialog.section, 'data')
    assert.equal(dialog.connectionFailure.cause.kind, kind)
    assert.equal(dialog.connectionFailure.cause.status, status)
    if (status) {
      assert.equal(
        dialog.connectionFailure.cause.message,
        status === 401 ? 'bad cached key' : 'forbidden model'
      )
    }
    assert.equal(api.useSettings.getState().apiKey, 'bad-cached-key')
    api.closeSettings()
    assert.equal(api.useSettingsDialog.getState().connectionFailure, null)
  }
})

test('startup validation skips absent credentials and ignores failures for replaced connections', async () => {
  let resolve
  let calls = 0
  const api = await loadApi({
    fetch: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  await api.validateCachedConnection()
  assert.equal(calls, 0)
  assert.equal(api.useSettingsDialog.getState().open, false)
  api.useSettings.setState({ apiKey: 'old-key' })
  const pending = api.validateCachedConnection()
  api.setConnection('new-key', 'https://gateway.test', ['new-model'])
  resolve(new Response('old key denied', { status: 403 }))
  await pending
  assert.equal(api.useSettingsDialog.getState().open, false)
  assert.equal(api.useSettingsDialog.getState().connectionFailure, null)
})
