import { ApiError, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageParam, MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { toOpenaiFileParts, type LocalFileLoader, type OpenaiPart } from './openaiAttachments.js'
import { createLiteralToolFilter } from './openaiSearch.js'
import { WEB_SEARCH_TOOL, FETCH_URL_TOOL, type OpenaiToolCall } from './openaiSearch.js'
import { streamClientMessage } from './openaiClientSearch.js'
import { buildResponsesRequest, responsesStreamEvents } from './openaiResponses.js'
import {
  cachedSearchMethod,
  detectSearchMethod,
  invalidateSearchMethod,
  type SearchMethod,
} from './openaiSearchCapabilities.js'

export type OpenaiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenaiPart[]
  tool_calls?: OpenaiToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export type OpenaiRequest = {
  model: string
  messages: OpenaiMessage[]
  stream: true
  stream_options: { include_usage: true }
  reasoning_effort?: 'high' | 'none'
  web_search_options?: Record<string, never>
  tools?: (typeof WEB_SEARCH_TOOL | typeof FETCH_URL_TOOL)[]
  tool_choice?: 'auto' | 'none'
}

export const buildOpenaiRequest = async (
  messages: MessageParam[],
  model: string,
  thinking: boolean,
  search: boolean,
  loadFile: LocalFileLoader,
  signal: AbortSignal,
  onAttachmentNotice?: (message: string) => void
): Promise<OpenaiRequest> => {
  if (!model) {
    throw new ApiError('protocol', 'Select a model in settings first')
  }
  const mapped: OpenaiMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (const message of messages) {
    signal.throwIfAborted()
    if (message.role === 'latest_reminder') {
      mapped.push({ role: 'system', content: message.content })
    } else if (message.role === 'assistant') {
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text) {
        mapped.push({ role: 'assistant', content: text })
      }
    } else if (typeof message.content === 'string') {
      mapped.push({ role: 'user', content: message.content })
    } else {
      const parts: OpenaiPart[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else {
          const file = await loadFile(block.source.file_id)
          if (file) {
            parts.push(...(await toOpenaiFileParts(file, signal, onAttachmentNotice)))
          }
        }
      }
      mapped.push({
        role: 'user',
        content: parts.length ? parts : '[Attachment unavailable locally]',
      })
    }
  }
  if (mapped.at(-1)?.role === 'assistant') {
    mapped.push({
      role: 'user',
      content: 'Continue your previous response from where it stopped. Do not repeat it.',
    })
  }
  return {
    model,
    messages: mapped,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: thinking ? 'high' : 'none',
    ...(search ? { web_search_options: {} } : {}),
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const readUsage = (value: unknown): MessageUsage | undefined => {
  const usage = record(value)
  if (
    !usage ||
    typeof usage.prompt_tokens !== 'number' ||
    typeof usage.completion_tokens !== 'number'
  ) {
    return undefined
  }
  const cached = record(usage.prompt_tokens_details)?.cached_tokens
  const cacheRead = typeof cached === 'number' ? cached : 0
  return {
    input_tokens: Math.max(0, usage.prompt_tokens - cacheRead),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: usage.completion_tokens,
  }
}

const stopReason = (reason: string): StopReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export async function* openaiStreamEvents(
  stream: ReadableStream<Uint8Array>,
  model: string,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let started = false
  let index = -1
  let active: 'text' | 'thinking' | null = null
  let blockText = ''
  let finish: StopReason | undefined
  let usage: MessageUsage | undefined
  let hasAnswer = false
  const filter = createLiteralToolFilter()
  for await (const frame of readServerSentEvents(stream, signal)) {
    signal.throwIfAborted()
    if (frame.data.trim() === '[DONE]') {
      if (!started || !finish) {
        throw new ApiError('protocol', 'Incomplete chat completion')
      }
      if (active) {
        yield { type: 'content_block_stop', index }
      }
      filter('', true)
      if (!hasAnswer) {
        yield {
          type: 'content_block_start',
          index: ++index,
          content_block: {
            type: 'text',
            text: '当前模型或渠道未执行搜索，或未返回可显示的回答。请更换支持联网搜索的模型或渠道，或重试。',
          },
        }
        yield { type: 'content_block_stop', index }
      }
      yield { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage }
      yield { type: 'message_stop' }
      return
    }
    let chunk: Record<string, unknown> | null
    try {
      chunk = record(JSON.parse(frame.data))
    } catch {
      if (frame.event === 'error') {
        throw new ApiError('stream', frame.data)
      }
      throw new ApiError('protocol', 'Invalid chat completion event')
    }
    const error = record(chunk?.error)
    if (error || frame.event === 'error') {
      throw new ApiError('stream', typeof error?.message === 'string' ? error.message : frame.data)
    }
    if (!chunk) {
      throw new ApiError('protocol', 'Invalid chat completion event')
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: { id: typeof chunk.id === 'string' ? chunk.id : '', model },
      }
    }
    usage = readUsage(chunk.usage) ?? usage
    const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : null
    if (!choice) {
      continue
    }
    const delta = record(choice.delta)
    const annotations = delta?.annotations
    for (const type of ['thinking', 'text'] as const) {
      const raw = delta?.[type === 'thinking' ? 'reasoning_content' : 'content']
      const text = type === 'text' && typeof raw === 'string' ? filter(raw) : raw
      if (type === 'text' && typeof text === 'string' && text.trim()) {
        hasAnswer = true
      }
      const citations = type === 'text' && Array.isArray(annotations) ? annotations : []
      if (!(typeof text === 'string' && text) && !citations.length) {
        continue
      }
      if (active !== type) {
        if (active) {
          yield { type: 'content_block_stop', index }
        }
        active = type
        blockText = ''
        index++
        yield {
          type: 'content_block_start',
          index,
          content_block:
            type === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : { type: 'text', text: '' },
        }
      }
      if (typeof text === 'string' && text) {
        blockText += text
        yield {
          type: 'content_block_delta',
          index,
          delta:
            type === 'thinking'
              ? { type: 'thinking_delta', thinking: text }
              : { type: 'text_delta', text },
        }
      }
      for (const annotation of citations) {
        const item = record(annotation)
        const citation = record(item?.url_citation) ?? item
        if (item?.type === 'url_citation' && typeof citation?.url === 'string') {
          yield {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'citations_delta',
              citation: {
                type: 'web_search_result_location',
                url: citation.url,
                title: typeof citation.title === 'string' ? citation.title : null,
                cited_text: blockText.trim(),
                encrypted_index: '',
              },
            },
          }
        }
      }
    }
    if (typeof choice.finish_reason === 'string') {
      finish = stopReason(choice.finish_reason)
    }
  }
  signal.throwIfAborted()
  throw new ApiError('interrupted', '')
}

const completion = (root: string, apiKey: string, body: unknown, signal: AbortSignal) =>
  request(`${root}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

export async function* streamChatMessage(
  root: string,
  apiKey: string,
  body: OpenaiRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await completion(root, apiKey, body, signal)
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new ApiError('protocol', 'Expected a chat completion event stream')
  }
  yield* openaiStreamEvents(response.body, body.model, signal)
}

class SearchRedirect extends Error {
  constructor(readonly method: SearchMethod) {
    super('Hosted search selected')
  }
}

export async function* streamOpenaiMessage(
  root: string,
  apiKey: string,
  body: OpenaiRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  if (!body.web_search_options) {
    yield* streamChatMessage(root, apiKey, body, signal)
    return
  }
  const cached = cachedSearchMethod(root, body.model)
  const tiers = ['chat', 'responses', 'client'] as const
  let remaining: SearchMethod[] = tiers.slice(tiers.indexOf(cached ?? 'client'))
  let needsDetection = cached === null
  let nextIndex = 0
  let started = false
  while (remaining.length) {
    const tier = remaining.shift()
    if (!tier) {
      break
    }
    const offset = nextIndex
    const activeBlocks = new Set<number>()
    try {
      const source =
        tier === 'chat'
          ? streamChatMessage(root, apiKey, body, signal)
          : tier === 'responses'
            ? (async function* () {
                const response = await request(`${root}/responses`, {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(buildResponsesRequest(body)),
                  signal,
                })
                if (
                  !response.body ||
                  !response.headers.get('Content-Type')?.includes('text/event-stream')
                ) {
                  throw new ApiError('protocol', 'Expected a Responses event stream')
                }
                yield* responsesStreamEvents(response.body, body.model, signal)
              })()
            : streamClientMessage(
                root,
                apiKey,
                {
                  ...body,
                  web_search_options: undefined,
                  tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL],
                  tool_choice: 'auto',
                },
                signal,
                () => invalidateSearchMethod(root, body.model),
                async () => {
                  if (!needsDetection) {
                    return
                  }
                  needsDetection = false
                  const method = await detectSearchMethod(root, apiKey, body.model, signal)
                  if (method !== 'client') {
                    throw new SearchRedirect(method)
                  }
                }
              )
      const terminal: MessageStreamEvent[] = []
      for await (const event of source) {
        if (event.type === 'message_start') {
          if (!started) {
            yield event
          }
          started = true
        } else if (event.type === 'message_stop' || event.type === 'message_delta') {
          terminal.push(event)
        } else {
          if ('index' in event) {
            nextIndex = Math.max(nextIndex, offset + event.index + 1)
            if (event.type === 'content_block_start') {
              activeBlocks.add(offset + event.index)
            }
            if (event.type === 'content_block_stop') {
              activeBlocks.delete(offset + event.index)
            }
            yield { ...event, index: offset + event.index }
          } else {
            yield event
          }
        }
      }
      yield* terminal
      return
    } catch (error) {
      signal.throwIfAborted()
      for (const index of activeBlocks) {
        yield { type: 'content_block_stop', index }
      }
      if (error instanceof SearchRedirect) {
        remaining = tiers.slice(tiers.indexOf(error.method))
        continue
      }
      invalidateSearchMethod(root, body.model)
      if (tier === 'client') {
        if (!started) {
          yield { type: 'message_start', message: { id: '', model: body.model } }
        }
        yield {
          type: 'content_block_start',
          index: nextIndex,
          content_block: { type: 'text', text: '\n\n当前模型不支持联网搜索' },
        }
        yield { type: 'content_block_stop', index: nextIndex }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
        yield { type: 'message_stop' }
        return
      }
    }
  }
}

export const generateOpenaiTitle = async (
  root: string,
  apiKey: string,
  model: string,
  question: string,
  answer: string,
  signal: AbortSignal
): Promise<string> => {
  const response = await completion(
    root,
    apiKey,
    {
      model,
      stream: false,
      max_tokens: 64,
      reasoning_effort: 'none',
      messages: [
        {
          role: 'system',
          content:
            "Write a short chat title in the user's language (at most 8 words). Output only the title. Do not reason or explain.",
        },
        {
          role: 'user',
          content: `Question: ${question.slice(0, 2000)}\nAnswer: ${answer.slice(0, 2000)}`,
        },
      ],
    },
    signal
  )
  const body = record(await response.json())
  const choice = Array.isArray(body?.choices) ? record(body.choices[0]) : null
  const content = record(choice?.message)?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError('protocol', 'Missing chat title')
  }
  return content
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .slice(0, 120)
}
