export type ResponseDetails = {
  body: string
  status?: number
  truncated: boolean
}

const MAX_BYTES = 20 * 1024

export const captureResponseDetails = (
  body: string,
  status?: number,
  apiKey?: string
): ResponseDetails | undefined => {
  if (!body) {
    return
  }
  let safe = body
  if (apiKey) {
    for (const key of new Set([
      apiKey,
      encodeURIComponent(apiKey),
      JSON.stringify(apiKey).slice(1, -1),
    ])) {
      safe = safe.replaceAll(key, '***')
    }
  }
  safe = safe
    .replace(
      /(["']?(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*)(\[\s*"(?:\\.|[^"\\])*"(?:\s*,\s*"(?:\\.|[^"\\])*")*\s*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'\\\r\n,;}<]+)/gi,
      (_, label: string, value: string) =>
        label +
        (value.startsWith('[')
          ? '["***"]'
          : /^["']/.test(value)
            ? value[0] + '***' + value[0]
            : '***')
    )
    .replace(/\bBearer[ \t]+[^\s"'\\,;<>}]+/gi, '***')
    .replace(/(?<![a-z\d])sk-[\w-]+/gi, '***')
    .replace(/https?:(?:\\?\/){2}(?:\\\/|\\u[\da-f]{4}|[^\s\\"'<>])+/gi, (url) => {
      const escaped = url.includes('\\/')
      const normalized = url.replaceAll('\\/', '/')
      const clean = normalized
        .split(/[?#]|\\u00(?:3f|23)/i, 1)[0]
        .replace(/^(https?:\/\/)[^/]*@/i, '$1')
      return escaped ? clean.replaceAll('/', '\\/') : clean
    })
  const bytes = new TextEncoder().encode(safe)
  const truncated = bytes.length > MAX_BYTES
  let end = MAX_BYTES
  if (truncated) {
    while ((bytes[end] & 0xc0) === 0x80) {
      end--
    }
  }
  return {
    body: truncated ? new TextDecoder().decode(bytes.subarray(0, end)) : safe,
    status,
    truncated,
  }
}
