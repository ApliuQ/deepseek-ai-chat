import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import { createLiteralToolFilter } from './openaiSearch.js'
import type { OpenaiRequest } from './openai.js'
import type { MessageStreamEvent, WebSearchResult } from './types.js'

export const buildResponsesRequest = (body: OpenaiRequest) => ({
  model: body.model,
  stream: true,
  reasoning: { effort: body.reasoning_effort ?? 'none', summary: 'auto' },
  tools: [{ type: 'web_search' }],
  include: ['web_search_call.action.sources'],
  input: body.messages
    .filter((message) => message.role !== 'tool')
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? [
              {
                type: message.role === 'assistant' ? 'output_text' : 'input_text',
                text: message.content,
              },
            ]
          : message.content.map((part) =>
              part.type === 'image_url'
                ? { type: 'input_image', image_url: part.image_url.url }
                : {
                    type: message.role === 'assistant' ? 'output_text' : 'input_text',
                    text: part.text,
                  }
            ),
    })),
})

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export async function* responsesStreamEvents(
  stream: ReadableStream<Uint8Array>,
  model: string,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let index = -1
  let active: 'text' | 'thinking' | null = null
  let answer = ''
  let started = false
  const seenSearch = new Set<string>()
  const seenCitations = new Set<string>()
  const filter = createLiteralToolFilter()
  for await (const frame of readServerSentEvents(stream, signal)) {
    signal.throwIfAborted()
    if (frame.data.trim() === '[DONE]') {
      continue
    }
    let event: Record<string, unknown>
    try {
      event = obj(JSON.parse(frame.data))
    } catch {
      throw new ApiError('protocol', 'Invalid Responses event')
    }
    const type = event.type ?? frame.event
    const response = obj(event.response)
    if (event.error || type === 'error' || type === 'response.failed') {
      throw new ApiError(
        'stream',
        String(
          obj(event.error ?? response.error).message ?? event.message ?? 'Responses request failed'
        )
      )
    }
    if (!started) {
      started = true
      yield { type: 'message_start', message: { id: String(response.id ?? ''), model } }
    }
    const textType =
      type === 'response.output_text.delta'
        ? 'text'
        : type === 'response.reasoning_summary_text.delta'
          ? 'thinking'
          : null
    if (textType && typeof event.delta === 'string') {
      const text = textType === 'text' ? filter(event.delta) : event.delta
      if (text) {
        if (active !== textType) {
          if (active) {
            yield { type: 'content_block_stop', index }
          }
          active = textType
          yield {
            type: 'content_block_start',
            index: ++index,
            content_block:
              textType === 'text'
                ? { type: 'text', text: '' }
                : { type: 'thinking', thinking: '', signature: '' },
          }
        }
        if (textType === 'text') {
          answer += text
        }
        yield {
          type: 'content_block_delta',
          index,
          delta:
            textType === 'text'
              ? { type: 'text_delta', text }
              : { type: 'thinking_delta', thinking: text },
        }
      }
    }
    const item = obj(event.item)
    const items =
      type === 'response.completed' && Array.isArray(response.output) ? response.output : [item]
    for (const raw of items) {
      const output = obj(raw)
      if (
        output.type === 'web_search_call' &&
        output.status === 'completed' &&
        !seenSearch.has(String(output.id))
      ) {
        seenSearch.add(String(output.id))
        if (active) {
          yield { type: 'content_block_stop', index }
          active = null
        }
        const action = obj(output.action)
        const query = typeof action.query === 'string' ? action.query : ''
        yield {
          type: 'content_block_start',
          index: ++index,
          content_block: {
            type: 'server_tool_use',
            id: String(output.id),
            name: 'deepseek_web_search',
            kind: 'search',
            caller: { type: 'direct' },
            input: { action: 'search', query, queries: [query] },
          },
        }
        yield { type: 'content_block_stop', index }
        const results: WebSearchResult[] = (
          Array.isArray(action.sources) ? action.sources : []
        ).flatMap((rawSource) => {
          const source = obj(rawSource)
          return typeof source.url === 'string'
            ? [
                {
                  type: 'web_search_result' as const,
                  url: source.url,
                  title: String(source.title ?? source.url),
                  snippet: '',
                  site_icon: null,
                  site_name: null,
                  encrypted_content: '',
                  page_age: null,
                },
              ]
            : []
        })
        yield {
          type: 'content_block_start',
          index: ++index,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: String(output.id),
            kind: 'search',
            content: results,
          },
        }
        yield { type: 'content_block_stop', index }
      }
    }
    const annotations = type === 'response.output_text.annotation.added' ? [event.annotation] : []
    for (const raw of items) {
      const content = obj(raw).content
      if (Array.isArray(content)) {
        for (const part of content) {
          const list = obj(part).annotations
          if (Array.isArray(list)) {
            annotations.push(...list)
          }
        }
      }
    }
    for (const raw of annotations) {
      const citation = obj(raw)
      if (
        citation.type !== 'url_citation' ||
        typeof citation.url !== 'string' ||
        seenCitations.has(citation.url)
      ) {
        continue
      }
      seenCitations.add(citation.url)
      if (active !== 'text') {
        if (active) {
          yield { type: 'content_block_stop', index }
        }
        active = 'text'
        yield {
          type: 'content_block_start',
          index: ++index,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: citation.url,
            title: String(citation.title ?? citation.url),
            cited_text: answer.trim(),
            encrypted_index: '',
          },
        },
      }
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (active) {
        yield { type: 'content_block_stop', index }
      }
      if (!answer.trim()) {
        yield {
          type: 'content_block_start',
          index: ++index,
          content_block: { type: 'text', text: '当前模型或渠道未返回可显示的回答。' },
        }
        yield { type: 'content_block_stop', index }
      }
      const usage = obj(response.usage)
      const cached = Number(obj(usage.input_tokens_details).cached_tokens ?? 0)
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: type === 'response.incomplete' ? 'max_tokens' : 'end_turn',
          stop_sequence: null,
        },
        ...(typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
          ? {
              usage: {
                input_tokens: Math.max(0, usage.input_tokens - cached),
                cache_read_input_tokens: cached,
                cache_creation_input_tokens: 0,
                output_tokens: usage.output_tokens,
              },
            }
          : {}),
      }
      yield { type: 'message_stop' }
      return
    }
  }
  signal.throwIfAborted()
  throw new ApiError('interrupted', 'Incomplete Responses stream')
}
