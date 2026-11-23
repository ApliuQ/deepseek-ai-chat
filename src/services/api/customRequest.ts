import { translate, type TranslationKey } from '../../i18n/index.js'
import { ApiError, request, type ApiErrorKind } from './client.js'

type Operation = 'customModelRequest' | 'customExaSearch' | 'customReadWebpage'

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
    status
  )
}

const sendCustomModelRequest = (url: string, apiKey: string, init: RequestInit) =>
  request(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  })

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
  body: Record<string, unknown>,
  limit: number,
  signal: AbortSignal
): Promise<Response> => {
  try {
    return await sendCustomModelRequest(url, apiKey, {
      method: 'POST',
      body: JSON.stringify({ ...body, max_completion_tokens: limit }),
      signal,
    })
  } catch (error) {
    signal.throwIfAborted()
    if (
      error instanceof ApiError &&
      error.status === 400 &&
      /\b(?:unsupported|unknown|unrecognized) parameter\s*:\s*['"`]?max_completion_tokens\b/i.test(
        error.message
      )
    ) {
      return requestCustomModel(url, apiKey, {
        method: 'POST',
        body: JSON.stringify({ ...body, max_tokens: limit }),
        signal,
      })
    }
    throw customRequestError('customModelRequest', url, error, apiKey)
  }
}
