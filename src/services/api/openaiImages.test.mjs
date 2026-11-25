import assert from 'node:assert/strict'
import test from 'node:test'
import { loadApi } from './testHarness.mjs'

// 1x1 PNG 头：宽高字段位于第 16–23 字节
const png = (width, height) => {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const imageResponse = (width = 1254, height = 1254) =>
  new Response(JSON.stringify({ data: [{ b64_json: b64(png(width, height)) }] }), {
    headers: { 'Content-Type': 'application/json' },
  })

const createHost = (overrides = {}) => {
  const saved = []
  return {
    saved,
    host: {
      root: 'https://gateway.test/v1',
      apiKey: 'secret',
      model: 'gpt-image-2.6-sunburst',
      remaining: 10,
      process: async (blob, options) => ({
        blob: new Blob([await blob.arrayBuffer()], { type: `image/${options.format}` }),
        width: options.width,
        height: options.height,
      }),
      loadImage: async () => undefined,
      saveImage: async (blob, name) => {
        saved.push({ blob, name })
        return { fileId: `file-${saved.length}`, imageId: `local-file:file-${saved.length}` }
      },
      ...overrides,
    },
  }
}

const drive = async (generator) => {
  const events = []
  for (;;) {
    const step = await generator.next()
    if (step.done) {
      return { events, result: step.value }
    }
    events.push(step.value)
  }
}

const call = (name, args) => ({
  id: 'call_1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

test('image targets default to 1K, honor ratios, 2K and explicit sizes within limits', async () => {
  const api = await loadApi()
  const plain = (value) => ({ ...value })
  assert.deepEqual(plain(api.resolveImageTarget({})), { width: 1024, height: 1024, ratio: '1:1' })
  assert.deepEqual(plain(api.resolveImageTarget({ aspect_ratio: '16:9' })), {
    width: 1360,
    height: 768,
    ratio: '16:9',
  })
  assert.deepEqual(plain(api.resolveImageTarget({ aspect_ratio: '9:16', resolution: '2K' })), {
    width: 1152,
    height: 2048,
    ratio: '9:16',
  })
  assert.deepEqual(plain(api.resolveImageTarget({ size: '512x256' })), {
    width: 512,
    height: 256,
    ratio: '2:1',
  })
  assert.deepEqual(plain(api.resolveImageTarget({ size: '4096x4096' })), {
    width: 2048,
    height: 2048,
    ratio: '1:1',
  })
  assert.equal(api.resolveImageTarget({ aspect_ratio: '10:1' }).ratio, '3.00:1')
})

test('generate_image splits count into single-image requests and reports results', async () => {
  const requests = []
  const api = await loadApi({
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return imageResponse()
    },
  })
  const { host, saved } = createHost()
  const { events, result } = await drive(
    api.runImageTool(
      call('generate_image', { prompt: 'A red fox', aspect_ratio: '1:1', count: 3 }),
      0,
      host,
      new AbortController().signal
    )
  )
  assert.equal(requests.length, 3)
  for (const request of requests) {
    assert.equal(request.url, 'https://gateway.test/v1/images/generations')
    assert.equal(request.init.headers.Authorization, 'Bearer secret')
    assert.equal(request.body.model, 'gpt-image-2.6-sunburst')
    assert.equal(request.body.size, '1024x1024')
    assert.equal(request.body.n, undefined)
    assert.match(request.body.prompt, /^A red fox\n\nAspect ratio: 1:1 \(square/)
  }
  assert.equal(saved.length, 3)
  assert.equal(host.remaining, 7)
  assert.equal(events[0].type, 'content_block_start')
  assert.equal(events[0].content_block.status, 'wip')
  const last = events.filter((event) => event.type === 'content_block_delta').at(-1)
  assert.equal(last.delta.block.status, 'done')
  assert.equal(last.delta.block.images.length, 3)
  assert.equal(events.at(-1).type, 'content_block_stop')
  assert.equal(result.status, 'success')
  assert.deepEqual(
    Array.from(result.images, (image) => image.image_id),
    ['local-file:file-1', 'local-file:file-2', 'local-file:file-3']
  )
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('edit_image sends the target first and falls back to multipart after a JSON 400', async () => {
  const requests = []
  const api = await loadApi({
    fetch: async (url, init) => {
      requests.push({ url, init })
      return typeof init.body === 'string'
        ? new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 })
        : imageResponse(941, 1672)
    },
  })
  const { host } = createHost({
    loadImage: async (id) =>
      id === 'local-file:target'
        ? { blob: new Blob([png(768, 1360)], { type: 'image/png' }), name: 'target.png' }
        : id === 'local-file:logo'
          ? { blob: new Blob([png(64, 64)], { type: 'image/png' }), name: 'logo.png' }
          : undefined,
  })
  const { result } = await drive(
    api.runImageTool(
      call('edit_image', {
        prompt: 'Change only the sky to sunset; keep everything else unchanged.',
        target_image_id: 'local-file:target',
        reference_images: [{ image_id: 'local-file:logo', role: 'logo' }],
      }),
      1,
      host,
      new AbortController().signal
    )
  )
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.url.endsWith('/images/edits')))
  const json = JSON.parse(requests[0].init.body)
  assert.equal(json.images.length, 2)
  assert.match(json.images[0].image_url, /^data:image\/png;base64,/)
  assert.equal(json.size, '768x1360')
  const form = requests[1].init.body
  assert.deepEqual(
    form.getAll('image[]').map((file) => file.name),
    ['target.png', 'logo.png']
  )
  assert.equal(result.status, 'success')
})

test('image tools reject unknown image ids and enforce the per-reply limit', async () => {
  let fetched = 0
  const api = await loadApi({
    fetch: async () => {
      fetched++
      return imageResponse()
    },
  })
  const { host } = createHost()
  const unknown = await drive(
    api.runImageTool(
      call('edit_image', { prompt: 'Edit', target_image_id: 'local-file:missing' }),
      0,
      host,
      new AbortController().signal
    )
  )
  assert.match(unknown.result.error, /Unknown image_id/)
  host.remaining = 1
  const limited = await drive(
    api.runImageTool(
      call('generate_image', { prompt: 'Cats', count: 4 }),
      0,
      host,
      new AbortController().signal
    )
  )
  assert.equal(fetched, 1)
  assert.match(limited.result.limited, /Only 1 image/)
  assert.equal(host.remaining, 0)
})
