/** 浏览器端图片后处理：居中裁剪到目标比例、只缩小不放大、纯色背景转透明、格式转换 */
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'

export type ImageProcessOptions = {
  /** 目标宽高，只用于比例裁剪和缩小 */
  width: number
  height: number
  format: ImageOutputFormat
  /** 0–100，仅 jpeg / webp 使用 */
  compression?: number
  /** 需要去除的纯色背景 */
  chromaKey?: 'green' | 'magenta'
}

export type ProcessedImage = { blob: Blob; width: number; height: number }

/** 返回图与目标比例的偏差超过 2% 时才裁剪 */
const RATIO_TOLERANCE = 0.02

const KEY_COLORS = { green: [0, 255, 0], magenta: [255, 0, 255] } as const

const removeChromaKey = (data: Uint8ClampedArray, key: 'green' | 'magenta') => {
  const [kr, kg, kb] = KEY_COLORS[key]
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const distance = Math.hypot(r - kr, g - kg, b - kb)
    // 距离 < 90 视为背景，90–160 做半透明过渡，并去掉边缘溢色
    if (distance < 90) {
      data[i + 3] = 0
    } else if (distance < 160) {
      data[i + 3] = Math.round(((distance - 90) / 70) * (data[i + 3] ?? 255))
      if (key === 'green') {
        data[i + 1] = Math.min(g, Math.max(r, b))
      } else {
        const limit = g
        data[i] = Math.min(r, Math.max(limit, (r + g) / 2))
        data[i + 2] = Math.min(b, Math.max(limit, (b + g) / 2))
      }
    }
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))),
      type,
      quality
    )
  )

export const processImage = async (
  source: Blob,
  { width, height, format, compression, chromaKey }: ImageProcessOptions
): Promise<ProcessedImage> => {
  const bitmap = await createImageBitmap(source)
  try {
    const target = width / height
    const actual = bitmap.width / bitmap.height
    let sx = 0
    let sy = 0
    let sw = bitmap.width
    let sh = bitmap.height
    if (Math.abs(actual / target - 1) > RATIO_TOLERANCE) {
      if (actual > target) {
        sw = Math.round(bitmap.height * target)
        sx = Math.round((bitmap.width - sw) / 2)
      } else {
        sh = Math.round(bitmap.width / target)
        sy = Math.round((bitmap.height - sh) / 2)
      }
    }
    const scale = Math.min(1, width / sw, height / sh)
    const outWidth = Math.max(1, Math.round(sw * scale))
    const outHeight = Math.max(1, Math.round(sh * scale))
    const unchanged =
      sw === bitmap.width && sh === bitmap.height && scale === 1 && !chromaKey && format === 'png'
    if (unchanged && source.type === 'image/png') {
      return { blob: source, width: outWidth, height: outHeight }
    }
    const canvas = document.createElement('canvas')
    canvas.width = outWidth
    canvas.height = outHeight
    const context = canvas.getContext('2d', { willReadFrequently: !!chromaKey })
    if (!context) {
      throw new Error('浏览器不支持图片处理')
    }
    context.imageSmoothingQuality = 'high'
    if (format === 'jpeg' && !chromaKey) {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, outWidth, outHeight)
    }
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outWidth, outHeight)
    if (chromaKey) {
      const pixels = context.getImageData(0, 0, outWidth, outHeight)
      removeChromaKey(pixels.data, chromaKey)
      context.putImageData(pixels, 0, 0)
    }
    // 透明背景只能用 png
    const type = chromaKey || format === 'png' ? 'image/png' : `image/${format}`
    const quality = type === 'image/png' ? undefined : (compression ?? 85) / 100
    return { blob: await toBlob(canvas, type, quality), width: outWidth, height: outHeight }
  } finally {
    bitmap.close()
  }
}
