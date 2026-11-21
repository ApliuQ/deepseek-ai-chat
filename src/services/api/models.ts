import { verifyApiKey } from './client.js'
import { getApiProvider, setOpenaiModels, useSettings } from '../settings.js'

const MAX_AGE = 5 * 60 * 1000
let cached: { baseUrl: string; apiKey: string; updatedAt: number } | undefined
let pending: { baseUrl: string; apiKey: string; promise: Promise<void> } | undefined

export const refreshOpenaiModels = (): Promise<void> => {
  const { baseUrl, apiKey, openaiModels } = useSettings.getState()
  if (!apiKey || getApiProvider(baseUrl) !== 'openai') {
    return Promise.resolve()
  }
  if (pending?.baseUrl === baseUrl && pending.apiKey === apiKey) {
    return pending.promise
  }
  if (
    openaiModels.length &&
    cached?.baseUrl === baseUrl &&
    cached.apiKey === apiKey &&
    Date.now() - cached.updatedAt < MAX_AGE
  ) {
    return Promise.resolve()
  }
  const promise = verifyApiKey(apiKey, baseUrl)
    .then((models) => {
      const current = useSettings.getState()
      if (current.baseUrl !== baseUrl || current.apiKey !== apiKey) {
        return
      }
      setOpenaiModels(models)
      cached = { baseUrl, apiKey, updatedAt: Date.now() }
    })
    .finally(() => {
      if (pending?.promise === promise) {
        pending = undefined
      }
    })
  pending = { baseUrl, apiKey, promise }
  return promise
}
