import { ApiError } from './client.js'
import { customRequestError } from './customRequest.js'
import { captureResponseDetails } from './responseDetails.js'
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

const download = async (
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  operation: 'customExaSearch' | 'customReadWebpage',
  apiKey?: string
) => {
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
      const body = await response.text().catch(() => '')
      throw new ApiError(
        'http',
        '',
        response.status,
        captureResponseDetails(body, response.status, apiKey)
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
      return {
        text: text + decoder.decode(),
        type: response.headers.get('Content-Type') ?? '',
        status: response.status,
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch (error) {
    signal.throwIfAborted()
    throw customRequestError(operation, url, error, apiKey, controller.signal.aborted)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

const exa = async (
  name: 'web_search_exa' | 'web_fetch_exa',
  args: Record<string, unknown>,
  signal: AbortSignal,
  apiKey?: string
) => {
  const operation = name === 'web_search_exa' ? 'customExaSearch' : 'customReadWebpage'
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
    signal,
    operation,
    apiKey
  )
  const streaming = response.type.includes('text/event-stream')
  let errorBody = streaming ? '' : response.text
  try {
    const frames = streaming
      ? new ServerSentEventDecoder().push(`${response.text}\n\n`)
      : [{ event: '', data: response.text }]
    const matching = frames.find(({ event, data }) => {
      if (event === 'error') {
        return true
      }
      try {
        const frame = JSON.parse(data)
        return frame?.id === 1 || (frame?.id == null && !!frame?.error)
      } catch (error) {
        errorBody = data
        throw error
      }
    })
    errorBody = matching?.data ?? errorBody
    const frame = matching?.event === 'error' || !matching ? undefined : JSON.parse(matching.data)
    const content: unknown = frame?.result?.content
    if (frame?.error || frame?.result?.isError || !Array.isArray(content)) {
      throw new Error('Invalid Exa response')
    }
    const text = content
      .flatMap((item) =>
        item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      )
      .join('\n')
    if (!text.trim()) {
      throw new Error('Empty Exa response')
    }
    return text
  } catch {
    throw customRequestError(
      operation,
      EXA,
      new ApiError(
        'protocol',
        '',
        undefined,
        captureResponseDetails(errorBody, streaming ? undefined : response.status, apiKey)
      ),
      apiKey
    )
  }
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
  signal: AbortSignal,
  apiKey?: string
): Promise<WebSearchResult[]> => {
  const text = await exa(
    'web_search_exa',
    {
      query,
      objective:
        'Find relevant trustworthy sources that answer this query. Return source titles, URLs and useful factual excerpts.',
      numResults: 5,
    },
    signal,
    apiKey
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
  signal: AbortSignal,
  apiKey?: string
): Promise<WebSearchResult[]> => {
  const url = publicWebUrl(value)
  let text: string
  try {
    text = await exa('web_fetch_exa', { urls: [url], maxCharacters: 12000 }, signal, apiKey)
  } catch {
    signal.throwIfAborted()
    const endpoint = `https://r.jina.ai/${url}`
    text = (await download(endpoint, { method: 'GET' }, signal, 'customReadWebpage', apiKey)).text
    if (!text.trim()) {
      throw customRequestError('customReadWebpage', endpoint, new ApiError('protocol', ''))
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
