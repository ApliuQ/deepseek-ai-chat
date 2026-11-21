import assert from 'node:assert/strict'
import test from 'node:test'
import { loadApi } from './testHarness.mjs'

test('DeepSeek speech requests retain their exact paths and payloads', async () => {
  const calls = []
  const api = await loadApi({
    fetch: async (url, init) => {
      calls.push([url, init])
      return url.endsWith('/asr')
        ? Response.json({ text: 'transcribed' })
        : new Response(new Uint8Array([0, 0]))
    },
  })
  const signal = new AbortController().signal
  assert.equal(await api.transcribe('key', new Blob(['audio']), signal), 'transcribed')
  assert.equal(calls[0][0], 'https://api.deepseek.com/v1/tools/asr')
  assert.deepEqual([...calls[0][1].body.keys()], ['file'])
  await api.synthesize('key', 'hello', 'stella', signal)
  assert.equal(calls[1][0], 'https://api.deepseek.com/v1/tools/tts')
  assert.equal(
    calls[1][1].body,
    JSON.stringify({ text: 'hello', voice_id: 'stella', format: 'pcm', filter_markdown: true })
  )
  assert.equal(calls[1][1].headers.Authorization, 'Bearer key')
})

test('OpenAI ASR and both TTS voices use normalized audio endpoints', async () => {
  const calls = []
  const api = await loadApi({
    fetch: async (url, init) => {
      calls.push([url, init])
      return url.endsWith('/transcriptions')
        ? Response.json({ text: 'hello' })
        : new Response(new Uint8Array([0, 0]))
    },
  })
  api.useSettings.setState({ baseUrl: 'https://example.test/' })
  const signal = new AbortController().signal
  assert.equal(
    await api.transcribe('key', new Blob(['audio'], { type: 'audio/wav' }), signal),
    'hello'
  )
  assert.equal(calls[0][0], 'https://example.test/v1/audio/transcriptions')
  assert.equal(calls[0][1].body.get('model'), 'whisper-1')
  assert.equal(calls[0][1].body.get('file').name, 'recording.wav')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer key')
  for (const [voice, expected] of [
    ['stella', 'nova'],
    ['tide', 'onyx'],
  ]) {
    await api.synthesize('key', 'hello', voice, signal)
    const [url, init] = calls.at(-1)
    assert.equal(url, 'https://example.test/v1/audio/speech')
    assert.equal(
      init.body,
      JSON.stringify({ model: 'tts-1', input: 'hello', voice: expected, response_format: 'pcm' })
    )
    assert.equal(init.signal, signal)
  }
  assert.equal(api.TTS_SAMPLE_RATE, 24000)
})

test('speech HTTP denial and malformed ASR responses reject readably', async () => {
  let response
  const api = await loadApi({ fetch: async () => response })
  api.useSettings.setState({ baseUrl: 'https://example.test/v1' })
  const signal = new AbortController().signal
  for (const operation of [
    () => api.transcribe('key', new Blob(['audio']), signal),
    () => api.synthesize('key', 'hello', 'stella', signal),
  ]) {
    response = Response.json({ error: { message: '无权访问模型 tts-1' } }, { status: 403 })
    await assert.rejects(operation(), { kind: 'http', status: 403, message: '无权访问模型 tts-1' })
  }
  for (const value of [{}, { text: null }]) {
    response = Response.json(value)
    await assert.rejects(api.transcribe('key', new Blob(['audio']), signal), { kind: 'protocol' })
  }
})
