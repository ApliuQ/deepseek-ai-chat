import assert from 'node:assert/strict'
import test from 'node:test'
import { loadApi } from './testHarness.mjs'

const signal = () => new AbortController().signal

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

test('OpenAI transcription uses selected-model input_audio while TTS endpoints stay normalized', async () => {
  const calls = []
  const api = await loadApi({
    fetch: async (url, init) => {
      calls.push([url, init])
      return url.endsWith('/chat/completions')
        ? Response.json({ choices: [{ message: { content: 'hello' } }] })
        : new Response(new Uint8Array([0, 0]))
    },
  })
  api.useSettings.setState({ baseUrl: 'https://example.test/', openaiModel: 'audio-model' })
  const signal = new AbortController().signal
  assert.equal(
    await api.transcribe('key', new Blob(['audio'], { type: 'audio/wav' }), signal),
    'hello'
  )
  assert.equal(calls[0][0], 'https://example.test/v1/chat/completions')
  const request = JSON.parse(calls[0][1].body)
  assert.equal(request.model, 'audio-model')
  assert.deepEqual(request.messages[0].content[1], {
    type: 'input_audio',
    input_audio: { data: 'YXVkaW8=', format: 'wav' },
  })
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
  api.useSettings.setState({ baseUrl: 'https://example.test/v1', openaiModel: 'model' })
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

test('custom MP3 input, empty/unsupported audio, model refusal and cancellation', async () => {
  let body
  const api = await loadApi({
    fetch: async (_url, init) => {
      body = JSON.parse(init.body)
      return Response.json({ choices: [{ message: { content: '[无法识别音频]' } }] })
    },
  })
  api.useSettings.setState({ baseUrl: 'https://custom.test', openaiModel: 'selected' })
  await assert.rejects(
    api.transcribe('key', new Blob(['mp3'], { type: 'audio/mpeg' }), signal()),
    /无法识别音频/
  )
  assert.equal(body.messages[0].content[1].input_audio.format, 'mp3')
  assert.equal(body.model, 'selected')
  await assert.rejects(api.transcribe('key', new Blob([]), signal()), /录音为空/)
  await assert.rejects(
    api.transcribe('key', new Blob(['ogg'], { type: 'audio/ogg' }), signal()),
    /WAV 或 MP3/
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(api.transcribe('key', new Blob(['wav']), controller.signal), {
    name: 'AbortError',
  })
})

test('custom transcription reports an explicit missing-audio refusal instead of filling it into input', async () => {
  const api = await loadApi({
    fetch: async () =>
      Response.json({
        choices: [
          {
            message: { content: '我无法访问这段录音，因为你没有提供音频文件或链接。请上传音频。' },
          },
        ],
      }),
  })
  api.useSettings.setState({ baseUrl: 'https://custom.test', openaiModel: 'selected' })
  await assert.rejects(
    api.transcribe('key', new Blob(['mp3'], { type: 'audio/mpeg' }), signal()),
    /当前模型无法识别音频/
  )
})
