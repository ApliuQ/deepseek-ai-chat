import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  baseUrl: string
  openaiModel: string
  openaiModels: string[]
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  baseUrl: 'chat-demo:base-url',
  openaiModel: 'chat-demo:openai-model',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '')

export const getApiProvider = (baseUrl: string): 'deepseek' | 'openai' => {
  const normalized = normalizeBaseUrl(baseUrl)
  const origin = normalizeBaseUrl(__API_ORIGIN__)
  return [origin, `${origin}/v1`, `${origin}/anthropic`].includes(normalized)
    ? 'deepseek'
    : 'openai'
}

export const getOpenaiRoot = (baseUrl: string): string => {
  const normalized = normalizeBaseUrl(baseUrl)
  return /\/v\d+(?:\.\d+)*$/.test(normalized) ? normalized : `${normalized}/v1`
}

export const getApiOrigin = (): string => {
  const baseUrl = normalizeBaseUrl(useSettings.getState().baseUrl)
  return getApiProvider(baseUrl) === 'deepseek' ? normalizeBaseUrl(__API_ORIGIN__) : baseUrl
}

const initialBaseUrl = (): string => {
  const saved = read(KEYS.baseUrl)
  if (saved) {
    return saved
  }
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    const explicit = params.get('baseUrl') || params.get('base_url')
    if (explicit?.trim()) {
      return normalizeBaseUrl(explicit)
    }
    if (window.self !== window.top) {
      try {
        const parent = window.location.ancestorOrigins?.[0] || new URL(document.referrer).origin
        if (parent && parent !== 'null') {
          return getOpenaiRoot(parent)
        }
      } catch {
        // 无法读取嵌入来源时使用构建默认值
      }
    }
  }
  return __API_ORIGIN__
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  baseUrl: initialBaseUrl(),
  openaiModel: read(KEYS.openaiModel) ?? '',
  openaiModels: [],
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setConnection = (apiKey: string, baseUrl: string, models: string[]) => {
  const normalized = normalizeBaseUrl(baseUrl)
  const previous = useSettings.getState()
  const openaiModel = models.includes(previous.openaiModel)
    ? previous.openaiModel
    : (models[0] ?? '')
  write(KEYS.apiKey, apiKey)
  write(KEYS.baseUrl, normalized)
  write(KEYS.openaiModel, openaiModel)
  useSettings.setState({ apiKey, baseUrl: normalized, openaiModel, openaiModels: models })
}

export const setOpenaiModel = (openaiModel: string) => {
  write(KEYS.openaiModel, openaiModel)
  useSettings.setState({ openaiModel })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
