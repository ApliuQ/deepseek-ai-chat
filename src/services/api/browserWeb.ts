import { ApiError } from './client.js'
import { ServerSentEventDecoder } from './sse.js'
import type { WebSearchResult } from './types.js'

const EXA = 'https://mcp.exa.ai/mcp'
const MAX_RESPONSE = 2 * 1024 * 1024

export const publicWebUrl = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('fetch_url requires a public HTTP(S) URL without credentials')
  }
  return url.href
}

const download = async (url: string, init: RequestInit, signal: AbortSignal) => {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, {
      ...init,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new ApiError(
        'http',
        `Web service returned HTTP ${response.status}${response.status === 429 ? ' (rate limited; try again later)' : ''}`,
        response.status
      )
    }
    if (!response.body) {
      throw new Error('Empty web service response')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        size += value.byteLength
        if (size > MAX_RESPONSE) {
          throw new Error('Web service response exceeds 2 MiB')
        }
        text += decoder.decode(value, { stream: true })
      }
      return { text: text + decoder.decode(), type: response.headers.get('Content-Type') ?? '' }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch (error) {
    signal.throwIfAborted()
    if (controller.signal.aborted) {
      throw new Error('Web service timed out after 20 seconds')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

const exa = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
  const response = await download(
    EXA,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    },
    signal
  )
  const frames = response.type.includes('text/event-stream')
    ? new ServerSentEventDecoder()
        .push(`${response.text}\n\n`)
        .map((event) => JSON.parse(event.data))
    : [JSON.parse(response.text)]
  const frame = frames.find((item) => item.id === 1)
  if (frame?.error || frame?.result?.isError) {
    throw new Error('Exa could not execute the requested tool')
  }
  const content: unknown = frame?.result?.content
  if (!Array.isArray(content)) {
    throw new Error('Invalid Exa response')
  }
  const text = content
    .flatMap((item) => (item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []))
    .join('\n')
  if (!text.trim()) {
    throw new Error('Empty Exa response')
  }
  return text
}

const result = (url: string, title: string, snippet: string): WebSearchResult => ({
  type: 'web_search_result',
  url,
  title,
  snippet,
  site_name: new URL(url).hostname,
  site_icon: null,
  page_age: null,
  encrypted_content: '',
})

export const searchBrowserWeb = async (
  query: string,
  signal: AbortSignal
): Promise<WebSearchResult[]> => {
  const text = await exa(
    'web_search_exa',
    {
      query,
      objective:
        'Find relevant trustworthy sources that answer this query. Return source titles, URLs and useful factual excerpts.',
      numResults: 5,
    },
    signal
  )
  return text
    .split(/(?=^Title: )/m)
    .flatMap((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]
      const url = block.match(/^URL: (\S+)/m)?.[1]
      if (!title || !url) {
        return []
      }
      try {
        return [
          result(
            publicWebUrl(url),
            title,
            block
              .replace(/^[\s\S]*?^Highlights:\s*/m, '')
              .trim()
              .slice(0, 12000)
          ),
        ]
      } catch {
        return []
      }
    })
    .slice(0, 5)
}

export const fetchBrowserUrl = async (
  value: string,
  signal: AbortSignal
): Promise<WebSearchResult[]> => {
  const url = publicWebUrl(value)
  let text: string
  try {
    text = await exa('web_fetch_exa', { urls: [url], maxCharacters: 12000 }, signal)
  } catch {
    signal.throwIfAborted()
    text = (await download(`https://r.jina.ai/${url}`, { method: 'GET' }, signal)).text
    if (!text.trim()) {
      throw new Error('Empty page content')
    }
  }
  return [
    result(
      url,
      text.match(/^(?:Title: |# )(.+)/m)?.[1] ?? new URL(url).hostname,
      text.slice(0, 12000)
    ),
  ]
}
