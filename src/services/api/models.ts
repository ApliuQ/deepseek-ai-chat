import { verifyApiKey } from './client.js'
import { getApiProvider, setDeepseekModels, setOpenaiModels, useSettings } from '../settings.js'

const MAX_AGE = 5 * 60 * 1000
let cached: { baseUrl: string; apiKey: string; updatedAt: number } | undefined
let pending: { baseUrl: string; apiKey: string; promise: Promise<void> } | undefined

export const refreshModels = (): Promise<void> => {
  const { baseUrl, apiKey, openaiModels, deepseekModels } = useSettings.getState()
  const openai = getApiProvider(baseUrl) === 'openai'
  const models = openai ? openaiModels : deepseekModels
  if (!apiKey) {
    return Promise.resolve()
  }
  if (pending?.baseUrl === baseUrl && pending.apiKey === apiKey) {
    return pending.promise
  }
  if (
    models.length &&
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
      if (openai) {
        setOpenaiModels(models)
      } else {
        setDeepseekModels(models)
      }
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
