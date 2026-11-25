import { useEffect } from 'react'
import {
  getApiProvider,
  setDeepseekModel,
  setOpenaiModel,
  sortOpenaiModelNames,
  useSettings,
} from '../../services/settings.js'
import { refreshModels } from '../../services/api/models.js'
import { useTranslate } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './ModelPicker.module.css'

export const ModelPicker = () => {
  const { baseUrl, apiKey, openaiModel, openaiModels, deepseekModel, deepseekModels } =
    useSettings()
  const t = useTranslate()
  const openai = getApiProvider(baseUrl) === 'openai'
  const model = openai ? openaiModel : deepseekModel
  const models = openai ? openaiModels : deepseekModels
  const refresh = () => void refreshModels().catch(() => {})

  useEffect(() => {
    if (!apiKey) {
      return
    }
    const refresh = () => void refreshModels().catch(() => {})
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [baseUrl, apiKey])

  return (
    <div className={styles.picker} data-model-picker onPointerDown={refresh} onFocus={refresh}>
      <Select
        className={styles.trigger}
        ariaLabel={t('openaiModelLabel')}
        placeholder={t('openaiModelLabel')}
        value={model}
        options={(models.length
          ? openai
            ? sortOpenaiModelNames(models)
            : models
          : model
            ? [model]
            : []
        ).map((id) => ({
          value: id,
          label: id,
        }))}
        onChange={openai ? setOpenaiModel : setDeepseekModel}
      />
    </div>
  )
}
