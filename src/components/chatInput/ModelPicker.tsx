import { useEffect } from 'react'
import { getApiProvider, setOpenaiModel, useSettings } from '../../services/settings.js'
import { refreshOpenaiModels } from '../../services/api/models.js'
import { useTranslate } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './ModelPicker.module.css'

export const ModelPicker = () => {
  const { baseUrl, apiKey, openaiModel, openaiModels } = useSettings()
  const t = useTranslate()
  const openai = getApiProvider(baseUrl) === 'openai'
  const refresh = () => void refreshOpenaiModels().catch(() => {})

  useEffect(() => {
    if (!openai || !apiKey) {
      return
    }
    const refresh = () => void refreshOpenaiModels().catch(() => {})
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [baseUrl, apiKey, openai])

  if (!openai) {
    return null
  }
  return (
    <div className={styles.picker} onPointerDown={refresh} onFocus={refresh}>
      <Select
        className={styles.trigger}
        ariaLabel={t('openaiModelLabel')}
        placeholder={t('openaiModelLabel')}
        value={openaiModel}
        options={(openaiModels.length ? openaiModels : openaiModel ? [openaiModel] : []).map(
          (id) => ({ value: id, label: id })
        )}
        onChange={setOpenaiModel}
      />
    </div>
  )
}
