import { request } from './client.js'
import { requestCustomModelWithTokenLimit } from './customRequest.js'

export type SearchMethod = 'chat' | 'responses' | 'client'
const TTL = 24 * 60 * 60 * 1000
const pending = new Map<string, Promise<SearchMethod>>()

export const searchCapabilityKey = (root: string, model: string) => {
  const url = new URL(root)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return `chat-demo:search-capability:${JSON.stringify([url.href.replace(/\/+$/, ''), model])}`
}

export const invalidateSearchMethod = (root: string, model: string) => {
  try {
    localStorage.removeItem(searchCapabilityKey(root, model))
  } catch {
    // 隐私模式下不依赖持久化存储。
  }
}

const probe = async (root: string, apiKey: string, model: string): Promise<SearchMethod> => {
  const prompt = `Search the web for today's news (${new Date().toISOString().slice(0, 10)}). Give one headline with a source citation.`
  for (const method of ['chat', 'responses'] as const) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response =
        method === 'chat'
          ? await requestCustomModelWithTokenLimit(
              `${root}/chat/completions`,
              apiKey,
              {
                model,
                stream: false,
                reasoning_effort: 'none',
                messages: [{ role: 'user', content: prompt }],
                web_search_options: {},
              },
              512,
              controller.signal
            )
          : await request(`${root}/responses`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                model,
                stream: false,
                reasoning: { effort: 'none' },
                max_output_tokens: 768,
                input: prompt,
                tools: [{ type: 'web_search' }],
                include: ['web_search_call.action.sources'],
              }),
            })
      const data = await response.json()
      const supported =
        method === 'chat'
          ? data.choices?.some(
              (choice: {
                message?: {
                  annotations?: { type: string; url_citation?: { url?: string }; url?: string }[]
                }
              }) =>
                choice.message?.annotations?.some(
                  (annotation) =>
                    annotation.type === 'url_citation' &&
                    (annotation.url_citation?.url || annotation.url)
                )
            )
          : data.output?.some(
              (item: { type: string; status?: string }) =>
                item.type === 'web_search_call' && item.status === 'completed'
            )
      if (supported) {
        return method
      }
    } catch {
      // 不可达、超时和不支持的协议均降到下一层。
    } finally {
      clearTimeout(timer)
    }
  }
  return 'client'
}

export const cachedSearchMethod = (root: string, model: string): SearchMethod | null => {
  try {
    const cached = JSON.parse(localStorage.getItem(searchCapabilityKey(root, model)) ?? 'null')
    if (
      cached &&
      ['chat', 'responses', 'client'].includes(cached.method) &&
      typeof cached.expires === 'number' &&
      cached.expires > Date.now() &&
      cached.expires <= Date.now() + TTL
    ) {
      return cached.method
    }
  } catch {
    // 损坏或不可用的缓存不影响请求。
  }
  return null
}

export const detectSearchMethod = async (
  root: string,
  apiKey: string,
  model: string,
  signal: AbortSignal
): Promise<SearchMethod> => {
  signal.throwIfAborted()
  const cached = cachedSearchMethod(root, model)
  if (cached) {
    return cached
  }
  const key = searchCapabilityKey(root, model)
  let task = pending.get(key)
  if (!task) {
    task = probe(root.replace(/\/+$/, ''), apiKey, model)
      .then((method) => {
        try {
          localStorage.setItem(key, JSON.stringify({ method, expires: Date.now() + TTL }))
        } catch {
          // 存储配额不足时仅使用本轮探测结果。
        }
        return method
      })
      .finally(() => pending.delete(key))
    pending.set(key, task)
  }
  // 取消单个等待者不会中断其他会话共享的探测。
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    task.then(
      (method) => {
        signal.removeEventListener('abort', abort)
        resolve(method)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
