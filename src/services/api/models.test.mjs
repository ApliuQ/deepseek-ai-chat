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
  await Promise.all([api.refreshOpenaiModels(), api.refreshOpenaiModels()])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://gateway.test/v1/models')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer cached-key')
  assert.deepEqual(Array.from(api.useSettings.getState().openaiModels), ['a', 'z'])
  assert.equal(api.useSettings.getState().openaiModel, 'z')
  await api.refreshOpenaiModels()
  assert.equal(calls.length, 1)
  api.useSettings.setState({ openaiModels: [] })
  await api.refreshOpenaiModels()
  assert.equal(calls.length, 2)
  api.useSettings.setState({ apiKey: 'new-key' })
  await api.refreshOpenaiModels()
  assert.equal(calls.length, 3)
})

test('refresh skips DeepSeek/missing keys, rejects errors and ignores outdated connections', async () => {
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
  await api.refreshOpenaiModels()
  api.useSettings.setState({ baseUrl: 'https://gateway.test' })
  await api.refreshOpenaiModels()
  assert.equal(calls, 0)
  api.useSettings.setState({ apiKey: 'key' })
  const first = api.refreshOpenaiModels()
  api.useSettings.setState({ baseUrl: 'https://other.test' })
  resolve(Response.json({ data: [{ id: 'outdated' }] }))
  await first
  assert.equal(api.useSettings.getState().openaiModels.length, 0)
  const denied = api.refreshOpenaiModels()
  resolve(Response.json({ error: { message: 'denied' } }, { status: 403 }))
  await assert.rejects(denied, { status: 403 })
  const empty = api.refreshOpenaiModels()
  resolve(Response.json({ data: [] }))
  await assert.rejects(empty, { kind: 'protocol' })
  const retry = api.refreshOpenaiModels()
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
  await api.refreshOpenaiModels()
  assert.equal(calls, 1)
  assert.equal(api.useSettings.getState().openaiModel, 'available')
})
