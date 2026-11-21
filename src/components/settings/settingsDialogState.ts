import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { refreshModels } from '../../services/api/models.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  connectionFailure: null as { cause: unknown } | null,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section, connectionFailure: null })

export const closeSettings = () =>
  useSettingsDialog.setState({ open: false, connectionFailure: null })

export const validateCachedConnection = async () => {
  const { apiKey, baseUrl } = useSettings.getState()
  if (!apiKey) {
    return
  }
  try {
    await refreshModels()
  } catch (cause) {
    const current = useSettings.getState()
    if (current.apiKey === apiKey && current.baseUrl === baseUrl) {
      useSettingsDialog.setState({
        open: true,
        section: 'data',
        connectionFailure: { cause },
      })
    }
  }
}

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
