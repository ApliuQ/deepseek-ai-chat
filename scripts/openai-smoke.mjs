import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { zipSync, strToU8, zlibSync } from 'fflate'
import { collect, loadApi } from '../src/services/api/testHarness.mjs'

const { OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_RECORD_SSE } = process.env
assert.ok(
  OPENAI_BASE_URL && OPENAI_API_KEY && OPENAI_MODEL,
  'Set OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL'
)
let recorded = false
const api = await loadApi({
  fetch: async (url, init) => {
    const response = await fetch(url, init)
    if (
      OPENAI_RECORD_SSE &&
      !recorded &&
      JSON.parse(init.body ?? '{}').reasoning_effort === 'high'
    ) {
      recorded = true
      writeFileSync(OPENAI_RECORD_SSE, await response.clone().text())
    }
    return response
  },
})
const root = api.getOpenaiRoot(OPENAI_BASE_URL)
const models = await api.verifyApiKey(OPENAI_API_KEY, root)
assert.ok(models.includes(OPENAI_MODEL))
process.stdout.write('PASS models: configured model available\n')

const run = async (name, prompt, { thinking = false, file, expected } = {}) => {
  const signal = AbortSignal.timeout(120_000)
  const content = file
    ? [
        {
          type: file.isImage ? 'image' : 'document',
          source: { type: 'file', file_id: 'local:smoke' },
        },
        { type: 'text', text: prompt },
      ]
    : prompt
  const request = await api.buildOpenaiRequest(
    [{ role: 'user', content }],
    OPENAI_MODEL,
    thinking,
    false,
    async () => file,
    signal
  )
  const events = await collect(api.streamOpenaiMessage(root, OPENAI_API_KEY, request, signal))
  const text = events
    .flatMap((event) => (event.delta?.type === 'text_delta' ? [event.delta.text] : []))
    .join('')
  const reasoning = events
    .flatMap((event) => (event.delta?.type === 'thinking_delta' ? [event.delta.thinking] : []))
    .join('')
  assert.equal(events.at(-1).type, 'message_stop')
  assert.ok(text.trim(), `${name}: empty answer`)
  if (expected) {
    assert.match(text, expected)
  }
  if (thinking) {
    assert.ok(reasoning.length > 0, 'Expected reasoning_content')
  }
  process.stdout.write(
    `PASS ${name}: answer=${text.length} chars, thinking=${reasoning.length} chars, usage=${Boolean(events.at(-2).usage)}\n`
  )
  return text
}

const answer = await run('plain chat', 'Reply exactly SMOKE_PLAIN_OK.', {
  expected: /SMOKE_PLAIN_OK/,
})
await run('thinking on', 'What is 17 times 19? End with SMOKE_THINKING_OK.', {
  thinking: true,
  expected: /SMOKE_THINKING_OK/,
})

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const payload = Buffer.concat([Buffer.from(type), Buffer.from(data)])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(payload))
  return Buffer.concat([size, payload, checksum])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(32, 0)
header.writeUInt32BE(32, 4)
header[8] = 8
header[9] = 2
const pixels = Buffer.alloc(32 * (1 + 32 * 3))
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    pixels[y * 97 + 1 + x * 3] = 255
  }
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', zlibSync(pixels)),
  pngChunk('IEND', new Uint8Array()),
])
await run('image attachment', 'What color is the image? Answer in one English word.', {
  file: { name: 'square.png', isImage: true, blob: new Blob([png], { type: 'image/png' }) },
  expected: /red/i,
})
await run(
  'txt attachment',
  'Reply with the exact secret marker from the attached file, nothing else.',
  {
    file: { name: 'marker.txt', isImage: false, blob: new Blob(['Secret marker: TXT_INLINE_471']) },
    expected: /TXT_INLINE_471/,
  }
)
await run(
  'docx attachment',
  'Reply with the exact secret marker from the attached file, nothing else.',
  {
    file: {
      name: 'marker.docx',
      isImage: false,
      blob: new Blob([
        zipSync({
          'word/document.xml': strToU8(
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Secret marker: DOCX_INLINE_582</w:t></w:r></w:p></w:body></w:document>'
          ),
        }),
      ]),
    },
    expected: /DOCX_INLINE_582/,
  }
)
const title = await api.generateOpenaiTitle(
  root,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  'A smoke test conversation',
  answer,
  AbortSignal.timeout(120_000)
)
assert.ok(title.trim())
process.stdout.write(`PASS title generation: ${title.length} chars\n`)
api.useSettings.setState({ baseUrl: root })
for (const [name, operation] of [
  [
    'ASR',
    () =>
      api.transcribe(
        OPENAI_API_KEY,
        new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
        AbortSignal.timeout(30000)
      ),
  ],
  ['TTS', () => api.synthesize(OPENAI_API_KEY, 'Hello', 'stella', AbortSignal.timeout(30000))],
]) {
  try {
    await operation()
    process.stdout.write(`PASS ${name}: model access available\n`)
  } catch (error) {
    assert.equal(error.status, 403)
    assert.ok(error.message.trim())
    process.stdout.write(`PASS ${name}: readable HTTP 403: ${error.message}\n`)
  }
}
process.stdout.write('PASS all live smoke checks (image resize is stubbed for the Node harness)\n')
