import { translate, type TranslationKey } from '../../i18n/index.js'
import { ApiError, request, type ApiErrorKind } from './client.js'
import { captureResponseDetails } from './responseDetails.js'

type Operation = 'customModelRequest' | 'customExaSearch' | 'customReadWebpage'

export const requireCustomEventStream = async (
  response: Response,
  message: string,
  apiKey: string
): Promise<ReadableStream<Uint8Array>> => {
  if (response.body && response.headers.get('Content-Type')?.includes('text/event-stream')) {
    return response.body
  }
  const body = await response.text().catch(() => '')
  throw new ApiError(
    'protocol',
    message,
    undefined,
    captureResponseDetails(body, response.status, apiKey)
  )
}

const displayUrl = (value: string, apiKey?: string): string => {
  let address: string
  try {
    const url = new URL(value)
    address = url.origin + url.pathname
  } catch {
    return translate('customRequestUnknownUrl')
  }
  if (apiKey) {
    for (const key of new Set([apiKey, encodeURIComponent(apiKey)])) {
      address = address.replaceAll(key, '…')
    }
  }
  return address
}

export const customRequestError = (
  operation: Operation,
  url: string,
  error: unknown,
  apiKey?: string,
  timedOut = false
): ApiError => {
  if (error instanceof ApiError && error.localMessage?.key === 'customRequestFailed') {
    return error
  }
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
  const timeout = timedOut || name === 'TimeoutError'
  const kind: ApiErrorKind =
    error instanceof ApiError
      ? error.kind
      : timeout || name === 'TypeError'
        ? 'network'
        : 'protocol'
  const status = error instanceof ApiError ? error.status : undefined
  const reason: TranslationKey =
    status !== undefined
      ? 'customRequestHttpReason'
      : timeout
        ? 'customRequestTimeoutReason'
        : kind === 'network'
          ? 'customRequestNetworkReason'
          : 'customRequestResponseReason'
  return new ApiError(
    kind,
    {
      key: 'customRequestFailed',
      params: {
        operation: translate(operation),
        url: displayUrl(url, apiKey),
        reason: translate(reason, status === undefined ? undefined : { status }),
      },
    },
    status,
    error instanceof ApiError ? error.responseDetails : undefined
  )
}

const sendCustomModelRequest = (url: string, apiKey: string, init: RequestInit) =>
  request(
    url,
    {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    },
    (body, status) => captureResponseDetails(body, status, apiKey)
  )

export const requestCustomModel = async (
  url: string,
  apiKey: string,
  init: RequestInit
): Promise<Response> => {
  try {
    return await sendCustomModelRequest(url, apiKey, init)
  } catch (error) {
    init.signal?.throwIfAborted()
    throw customRequestError('customModelRequest', url, error, apiKey)
  }
}

export const requestCustomModelWithTokenLimit = async (
  url: string,
  apiKey: string,
  body: Record<string, unknown> & { max_tokens?: never; max_completion_tokens?: never },
  limit: number,
  signal: AbortSignal
): Promise<Response> => {
  let field: 'max_completion_tokens' | 'max_tokens' | undefined = 'max_completion_tokens'
  for (;;) {
    try {
      return await sendCustomModelRequest(url, apiKey, {
        method: 'POST',
        body: JSON.stringify(field ? { ...body, [field]: limit } : body),
        signal,
      })
    } catch (error) {
      signal.throwIfAborted()
      const rejected =
        error instanceof ApiError && error.status === 400
          ? error.message.match(
              /\b(?:unsupported|unknown|unrecognized) parameter\s*:\s*['"`]?(max_completion_tokens|max_tokens)\b|\b(max_completion_tokens|max_tokens)['"`]?\s+is not supported\b/i
            )
          : null
      if (!field || !rejected) {
        throw customRequestError('customModelRequest', url, error, apiKey)
      }
      const rejectedField = (rejected[1] ?? rejected[2])?.toLowerCase()
      field =
        field === 'max_completion_tokens' && rejectedField === 'max_completion_tokens'
          ? 'max_tokens'
          : undefined
    }
  }
}
