import { ApiError } from './client.js'
import type { OpenaiToolCall } from './openaiSearch.js'
import type {
  GeneratedImage,
  ImageGenerationBlock,
  MessageParam,
  MessageStreamEvent,
} from './types.js'
import type {
  ImageOutputFormat,
  ImageProcessOptions,
  ProcessedImage,
} from '../images/processImage.js'

/** 单轮回答最多生成的图片张数；接口每次请求只出 1 张 */
export const MAX_IMAGES_PER_REPLY = 10
/** 同时进行的图片请求数 */
const IMAGE_CONCURRENCY = 2
const IMAGE_TIMEOUT = 180_000
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRY_LIMIT = 2
const IMAGE_RETRY_DELAY = 2000
/** 1K 的目标面积与 2K 的长边 */
const BASE_AREA = 1024 * 1024
const EDGE_2K = 2048
const MIN_EDGE = 64
const MAX_RATIO = 3

const PROMPT_GUIDE =
  'Write `prompt` as a complete, self-contained English image spec in this labeled structure (omit empty lines, keep it concise): Use case / Asset type / Primary request / Input images (index and role of each attached image) / Scene/backdrop / Subject / Style/medium / Composition/framing / Lighting/mood / Color palette / Materials/textures / Text (verbatim, in quotes, exact spelling) / Constraints / Avoid. Keep the user’s intent and every explicit detail; add only details that materially help. Never put API parameters (size, format, count) in the prompt.'

const sharedProperties = {
  prompt: { type: 'string', description: PROMPT_GUIDE },
  aspect_ratio: {
    type: 'string',
    description:
      'Width:height inferred from the user’s need, e.g. 1:1 (avatar, icon, logo), 16:9 (banner, wallpaper, slide), 9:16 (phone wallpaper, story, poster), 4:3, 3:4, 3:2, 2:3, 21:9. Long:short side must not exceed 3:1. Default 1:1; for edits default to the target image’s ratio.',
  },
  resolution: {
    type: 'string',
    enum: ['1K', '2K'],
    description:
      'Default 1K (about 1024x1024 pixels). Use 2K only when the user explicitly asks for 2K / high resolution.',
  },
  size: {
    type: 'string',
    description:
      'Exact WIDTHxHEIGHT in pixels, only when the user gives concrete pixel dimensions . Overrides aspect_ratio and resolution.',
  },
  quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
  output_format: {
    type: 'string',
    enum: ['png', 'jpeg', 'webp'],
    description:
      'Default png. Follow the user’s explicit format; use jpeg when the user wants a smaller file.',
  },
  output_compression: {
    type: 'integer',
    minimum: 0,
    maximum: 100,
    description: 'jpeg/webp quality, default 85.',
  },
  transparent_background: {
    type: 'boolean',
    description:
      'True only when the user needs a transparent background (sticker, logo cutout, PNG asset). The subject is generated on a flat chroma-key background and the browser removes it.',
  },
  chroma_key: {
    type: 'string',
    enum: ['green', 'magenta'],
    description:
      'Key color for transparent_background; use magenta when the subject itself contains green.',
  },
  count: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_IMAGES_PER_REPLY,
    description:
      'Number of variants of this same prompt, default 1. For different contents call the tool again with a different prompt. At most 10 images per reply in total.',
  },
  reference_images: {
    type: 'array',
    description:
      'Images to send to the image service: user attachments or earlier generated images, by image_id. Include only images that are really needed (logo, product, person, style reference).',
    items: {
      type: 'object',
      properties: {
        image_id: { type: 'string' },
        role: {
          type: 'string',
          enum: ['reference', 'style', 'asset'],
          description:
            'reference: keep the subject/identity; style: borrow look only; asset: composite this element (e.g. logo) into the result.',
        },
      },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
} as const

export const GENERATE_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Create new images with the image service. Use for new images and for iterating on an unsatisfying result: rebuild the full prompt from the original request plus the user’s new feedback (change one thing per iteration and restate constraints). Attach user images (logo, product, person) through reference_images when they should appear in or guide the result. The images are shown to the user automatically.',
    parameters: {
      type: 'object',
      properties: {
        use_case: {
          type: 'string',
          enum: [
            'photorealistic-natural',
            'product-mockup',
            'ui-mockup',
            'infographic-diagram',
            'logo-brand',
            'illustration-story',
            'stylized-concept',
            'historical-scene',
            'scientific-educational',
            'ads-marketing',
            'productivity-visual',
          ],
        },
        ...sharedProperties,
      },
      required: ['prompt', 'aspect_ratio'],
      additionalProperties: false,
    },
  },
} as const

export const EDIT_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_image',
    description:
      'Modify an existing image (a user attachment, or the previously generated image when the user explicitly says to change that image and keep the rest). The prompt must state exactly what to change and repeat what must stay unchanged (“change only X; keep Y unchanged”). The result is shown to the user automatically.',
    parameters: {
      type: 'object',
      properties: {
        target_image_id: { type: 'string', description: 'image_id of the image to edit.' },
        use_case: {
          type: 'string',
          enum: [
            'text-localization',
            'identity-preserve',
            'precise-object-edit',
            'lighting-weather',
            'background-extraction',
            'style-transfer',
            'compositing',
            'sketch-to-render',
          ],
        },
        ...sharedProperties,
      },
      required: ['target_image_id', 'prompt'],
      additionalProperties: false,
    },
  },
} as const

export const IMAGE_TOOLS = [GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL]

export const isImageToolName = (name: string) => name === 'generate_image' || name === 'edit_image'

export const IMAGE_SYSTEM_PROMPT = [
  'Image generation is enabled. Call generate_image or edit_image when the user wants an image created or changed; do not describe an image instead of making it, and do not call the tools for ordinary questions.',
  'Before calling, understand the request and set every argument yourself: aspect ratio from the intended use, resolution (1K unless the user explicitly asks for 2K), size only for explicit pixels, format (png by default, jpeg for smaller files), count (default 1, max 10 per reply), transparent background, and which attached images to send.',
  'Every attached or generated image has an image_id shown next to it. Decide whether each attachment is needed by the image service; non-image files cannot be sent, so put their relevant content into the prompt.',
  'When the user is unhappy with a generated image and adds feedback, call generate_image again with the original request plus the feedback. Use edit_image with the previous generated image as target only when the user explicitly asks to modify that image while keeping the rest.',
  'After the tool returns, reply briefly in the user’s language; do not output image links or markdown images. If the result note says the service could not reach the requested resolution, tell the user the actual size.',
].join('\n')

/** 生图开关关闭但历史里有生成图时，避免模型照着历史去调用不存在的图片工具而返回空回答 */
export const IMAGE_TOOLS_OFF_PROMPT =
  'Image generation tools are currently turned off: you cannot call generate_image or edit_image in this reply. If the user asks for a new or edited image, answer in text and tell them to turn on the Image (生成图片) switch below the input box.'

export const hasGeneratedImages = (messages: MessageParam[]) =>
  messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.some(
        (block) => block.type === 'text' && block.text.includes('image(s) shown to the user')
      )
  )

export type ImageToolHost = {
  root: string
  apiKey: string
  model: string
  /** 按 image_id 读取原图 */
  loadImage: (id: string) => Promise<{ blob: Blob; name: string } | undefined>
  /** 保存生成结果，返回本地文件 id 与对模型暴露的 image_id */
  saveImage: (blob: Blob, name: string) => Promise<{ fileId: string; imageId: string }>
  process: (blob: Blob, options: ImageProcessOptions) => Promise<ProcessedImage>
  /** 本轮剩余可生成张数 */
  remaining: number
}

type Target = { width: number; height: number; ratio: string }

const even16 = (value: number) => Math.max(MIN_EDGE, Math.round(value / 16) * 16)

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** 由比例、分辨率或明确像素计算目标尺寸：1K 约 1024x1024 面积，2K 长边 2048；网页不设上限，服务端实际返回多大就用多大 */
export const resolveImageTarget = (args: {
  aspect_ratio?: unknown
  resolution?: unknown
  size?: unknown
}): Target => {
  const size =
    typeof args.size === 'string' ? /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(args.size) : null
  if (size) {
    const width = Math.max(MIN_EDGE, Number(size[1]))
    const ratio = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, width / Number(size[2]) || 1))
    const height = Math.max(MIN_EDGE, Math.round(width / ratio))
    const divisor = gcd(width, height)
    return { width, height, ratio: `${width / divisor}:${height / divisor}` }
  }
  const match =
    typeof args.aspect_ratio === 'string'
      ? /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(args.aspect_ratio)
      : null
  const raw = match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : 1
  const value = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, raw || 1))
  const ratio =
    match && value === raw
      ? `${match[1]}:${match[2]}`
      : value === 1
        ? '1:1'
        : `${value.toFixed(2)}:1`
  if (args.resolution === '2K') {
    return value >= 1
      ? { width: EDGE_2K, height: even16(EDGE_2K / value), ratio }
      : { width: even16(EDGE_2K * value), height: EDGE_2K, ratio }
  }
  const width = even16(Math.sqrt(BASE_AREA * value))
  const height = even16(Math.sqrt(BASE_AREA / value))
  return { width, height, ratio }
}

const CHROMA_HEX = { green: '#00ff00', magenta: '#ff00ff' } as const

const finalPrompt = (prompt: string, target: Target, chromaKey?: 'green' | 'magenta') => {
  const orientation =
    target.width === target.height
      ? 'square'
      : target.width > target.height
        ? 'landscape'
        : 'portrait'
  const lines = [
    prompt.trim(),
    '',
    `Aspect ratio: ${target.ratio} (${orientation}, about ${target.width}x${target.height} pixels). Compose the whole image for this frame.`,
  ]
  if (chromaKey) {
    lines.push(
      `Background: a perfectly flat, uniform solid ${chromaKey} (${CHROMA_HEX[chromaKey]}) chroma-key background with no shadows, gradients, texture or reflections; the subject must not contain ${chromaKey}, with crisp clean edges.`
    )
  }
  return lines.join('\n')
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const errorMessage = async (response: Response) => {
  const text = await response.text().catch(() => '')
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && message) {
      return message.slice(0, 300)
    }
  } catch {
    // 非 JSON 响应体
  }
  return (text || response.statusText || `HTTP ${response.status}`).slice(0, 300)
}

/** 单次图片请求：超时、网络错误与 408/425/429/5xx 有限重试 */
const postImage = async (
  host: ImageToolHost,
  endpoint: 'generations' | 'edits',
  body: () => string | FormData,
  signal: AbortSignal
): Promise<Response> => {
  const url = `${host.root}/images/${endpoint}`
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), IMAGE_TIMEOUT)
    const payload = body()
    let response: Response | undefined
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.apiKey}`,
          ...(typeof payload === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload,
        signal: controller.signal,
      })
    } catch {
      signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    if (response && (response.ok || !RETRY_STATUS.has(response.status))) {
      return response
    }
    if (attempt >= RETRY_LIMIT) {
      if (response) {
        return response
      }
      throw new ApiError('network', `图片服务请求失败：${url}`)
    }
    await wait(IMAGE_RETRY_DELAY * 2 ** attempt, signal)
  }
}

const blobToDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

const base64Blob = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: 'image/png' })
}

/** 解析 data[0].b64_json 或 data[0].url；图片地址不携带 API Key */
const readImage = async (response: Response, signal: AbortSignal): Promise<Blob> => {
  if (!response.ok) {
    throw new ApiError('http', await errorMessage(response), response.status)
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { b64_json?: unknown; url?: unknown }[]
  } | null
  const item = body?.data?.[0]
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    return base64Blob(item.b64_json)
  }
  if (typeof item?.url === 'string' && /^(https?:|data:)/.test(item.url)) {
    const image = await fetch(item.url, { signal })
    if (!image.ok) {
      throw new ApiError('http', `图片下载失败：HTTP ${image.status}`, image.status)
    }
    return image.blob()
  }
  throw new ApiError('protocol', '图片服务没有返回图片')
}

type InputImage = { blob: Blob; name: string; dataUrl: string }

/** 无输入图走 generations；带素材或编辑走 edits，先发 JSON，400/415 时改用 multipart */
const requestImage = async (
  host: ImageToolHost,
  prompt: string,
  target: Target,
  quality: string | undefined,
  inputs: InputImage[],
  signal: AbortSignal
): Promise<Blob> => {
  const fields = {
    model: host.model,
    prompt,
    size: `${target.width}x${target.height}`,
    output_format: 'png',
    ...(quality ? { quality } : {}),
  }
  if (!inputs.length) {
    const response = await postImage(host, 'generations', () => JSON.stringify(fields), signal)
    return readImage(response, signal)
  }
  const json = await postImage(
    host,
    'edits',
    () =>
      JSON.stringify({ ...fields, images: inputs.map(({ dataUrl }) => ({ image_url: dataUrl })) }),
    signal
  )
  if (json.status !== 400 && json.status !== 415) {
    return readImage(json, signal)
  }
  const multipart = await postImage(
    host,
    'edits',
    () => {
      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) {
        form.append(key, value)
      }
      for (const { blob, name } of inputs) {
        form.append('image[]', blob, name)
      }
      return form
    },
    signal
  )
  return readImage(multipart, signal)
}

const parseArgs = (call: OpenaiToolCall): Record<string, unknown> => {
  let value: unknown
  try {
    value = JSON.parse(call.function.arguments || '{}')
  } catch {
    value = null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid JSON arguments')
  }
  return value as Record<string, unknown>
}

const FORMATS = new Set<string>(['png', 'jpeg', 'webp'])
const QUALITIES = new Set<string>(['low', 'medium', 'high', 'auto'])

const referenceIds = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
    if (typeof item === 'string') {
      return [item]
    }
    const id = typeof item === 'object' && item ? (item as { image_id?: unknown }).image_id : null
    return typeof id === 'string' ? [id] : []
  })

const failed = (error: string, instruction: string) => ({ error, instruction })

/**
 * 执行一次图片工具调用：按张拆分请求（每次只出 1 张，最多同时 2 个），
 * 结果保存到本地并通过 image_generation 块展示，返回交给模型的工具结果。
 */
export async function* runImageTool(
  call: OpenaiToolCall,
  index: number,
  host: ImageToolHost,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent, Record<string, unknown>> {
  const tool = call.function.name === 'edit_image' ? 'edit_image' : 'generate_image'
  let args: Record<string, unknown>
  try {
    args = parseArgs(call)
  } catch (error) {
    return failed(String(error), 'Correct the tool arguments and retry the tool call.')
  }
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const targetId = typeof args.target_image_id === 'string' ? args.target_image_id : ''
  if (!prompt || (tool === 'edit_image' && !targetId)) {
    return failed(
      tool === 'edit_image' && !targetId ? 'target_image_id is required' : 'prompt is required',
      'Correct the tool arguments and retry the tool call.'
    )
  }
  if (host.remaining <= 0) {
    return failed(
      `At most ${MAX_IMAGES_PER_REPLY} images can be generated per reply.`,
      'Tell the user the limit was reached and they can ask again in a new message.'
    )
  }
  const requested = Math.min(MAX_IMAGES_PER_REPLY, Math.max(1, Math.floor(Number(args.count) || 1)))
  const count = Math.min(requested, host.remaining)
  const format = (
    FORMATS.has(args.output_format as string) ? args.output_format : 'png'
  ) as ImageOutputFormat
  const chromaKey =
    args.transparent_background === true
      ? args.chroma_key === 'magenta'
        ? ('magenta' as const)
        : ('green' as const)
      : undefined
  const quality = QUALITIES.has(args.quality as string) ? (args.quality as string) : undefined
  const compression =
    typeof args.output_compression === 'number'
      ? Math.min(100, Math.max(0, Math.round(args.output_compression)))
      : undefined

  const ids = [...(targetId ? [targetId] : []), ...referenceIds(args.reference_images)].filter(
    (id, position, all) => all.indexOf(id) === position
  )
  const inputs: InputImage[] = []
  for (const id of ids) {
    const image = await host.loadImage(id)
    if (!image) {
      return failed(
        `Unknown image_id: ${id}`,
        'Use only image_id values shown in the conversation.'
      )
    }
    inputs.push({ ...image, dataUrl: await blobToDataUrl(image.blob) })
  }
  let target = resolveImageTarget(args)
  // 编辑且未指定比例时沿用目标图比例
  if (tool === 'edit_image' && !args.aspect_ratio && !args.size && inputs[0]) {
    const size = await imageSize(inputs[0].blob)
    if (size) {
      target = resolveImageTarget({
        aspect_ratio: `${size.width}:${size.height}`,
        resolution: args.resolution,
      })
    }
  }
  host.remaining -= count
  let block: ImageGenerationBlock = {
    type: 'image_generation',
    id: call.id,
    tool,
    prompt,
    aspectRatio: target.ratio,
    count,
    status: 'wip',
    images: [],
  }
  yield { type: 'content_block_start', index, content_block: block }

  const fullPrompt = finalPrompt(prompt, target, chromaKey)
  const results: (GeneratedImage & { imageId: string })[] = []
  const errors: string[] = []
  const generateOne = async (position: number) => {
    try {
      const raw = await requestImage(host, fullPrompt, target, quality, inputs, signal)
      const processed = await host.process(raw, {
        width: target.width,
        height: target.height,
        format,
        compression,
        chromaKey,
      })
      const mimeType = processed.blob.type || 'image/png'
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]
      const name = `image-${Date.now()}-${position + 1}.${extension}`
      const saved = await host.saveImage(processed.blob, name)
      results.push({ ...saved, name, mimeType, width: processed.width, height: processed.height })
    } catch (error) {
      signal.throwIfAborted()
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (let start = 0; start < count; start += IMAGE_CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(IMAGE_CONCURRENCY, count - start) },
      (_, offset) => start + offset
    )
    await Promise.all(batch.map(generateOne))
    block = {
      ...block,
      images: results.map(({ fileId, name, mimeType, width, height }) => ({
        fileId,
        name,
        mimeType,
        width,
        height,
      })),
      ...(errors[0] ? { error: errors[0] } : {}),
      ...(start + IMAGE_CONCURRENCY >= count ? { status: results.length ? 'done' : 'failed' } : {}),
    }
    yield { type: 'content_block_delta', index, delta: { type: 'image_delta', block } }
  }
  yield { type: 'content_block_stop', index }
  host.remaining += errors.length

  if (!results.length) {
    return failed(
      errors[0] ?? 'Image generation failed',
      'Tell the user the image service failed and give the reason; do not claim an image was created.'
    )
  }
  const lower = results.some(
    (image) => image.width < target.width * 0.95 && image.height < target.height * 0.95
  )
  return {
    status: 'success',
    images: results.map(({ imageId, width, height, mimeType }) => ({
      image_id: imageId,
      width,
      height,
      format: mimeType.split('/')[1],
    })),
    requested: {
      width: target.width,
      height: target.height,
      aspect_ratio: target.ratio,
      count: requested,
    },
    ...(errors.length ? { failed_count: errors.length, failure: errors[0] } : {}),
    ...(count < requested
      ? {
          limited: `Only ${count} image(s) were generated: at most ${MAX_IMAGES_PER_REPLY} per reply.`,
        }
      : {}),
    ...(lower
      ? {
          note: 'The image service returned a lower resolution than requested. The image was kept at its actual size (not upscaled); tell the user the actual size.',
        }
      : {}),
    instruction:
      'The images are already displayed to the user. Reply briefly; do not output links or markdown images. Use these image_id values for later edits.',
  }
}

/** 读取 PNG / JPEG 头部宽高，读不到时返回 undefined */
export const imageSize = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer())
  const view = new DataView(bytes.buffer)
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 0xff) {
        return undefined
      }
      const marker = view.getUint8(offset + 1)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  return undefined
}
