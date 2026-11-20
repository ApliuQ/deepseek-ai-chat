import { useEffect, useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { getApiProvider, setOpenaiModel, useSettings } from '../../services/settings.js'
import { verifyApiKey } from '../../services/api/client.js'
import { Select } from '../base/Select.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** API Key 的编辑状态：输入框与移动端底部的「确定」按钮共用 */
export const useApiKeyEditor = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const [editing, setEditing] = useState(false)
  const form = useApiKeyForm(() => setEditing(false))
  return { apiKey, editing, setEditing, form, showInput: !apiKey || editing }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** API Key：保存后只显示掩码，点编辑按钮才能重新输入 */
export const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, setEditing, form, showInput } = editor
  const baseUrl = useSettings((state) => state.baseUrl)
  const model = useSettings((state) => state.openaiModel)
  const models = useSettings((state) => state.openaiModels)
  const openai = getApiProvider(baseUrl) === 'openai'

  useEffect(() => {
    if (!openai || !apiKey || models.length) {
      return
    }
    const controller = new AbortController()
    void verifyApiKey(apiKey, baseUrl, controller.signal)
      .then((ids) => {
        if (controller.signal.aborted) {
          return
        }
        useSettings.setState({ openaiModels: ids })
        if (!ids.includes(useSettings.getState().openaiModel)) {
          setOpenaiModel(ids[0] ?? '')
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [apiKey, baseUrl, openai, models.length])

  return (
    <>
      <div className={styles.cell}>
        <div className={styles.apiKey}>
          <label className={styles.label} htmlFor="connection-base-url">
            {t('baseUrlLabel')}
          </label>
          {showInput ? (
            <div className={styles.apiKeyInput}>
              <input
                id="connection-base-url"
                type="url"
                placeholder={t('baseUrlPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={form.baseUrl}
                disabled={form.verifying}
                onChange={(event) => form.setBaseUrl(event.target.value)}
              />
            </div>
          ) : (
            <div>{baseUrl}</div>
          )}
        </div>
      </div>
      <div className={styles.cell}>
        <div className={styles.apiKey}>
          <div className={styles.label}>{t('apiKeyStart')}</div>
          {apiKey && !editing ? (
            <div className={styles.apiKeySaved}>
              <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
              <IconButton
                tone="primary"
                icon={<IconEditOutline16 />}
                tooltip={t('apiKeyEdit')}
                onClick={() => setEditing(true)}
              />
            </div>
          ) : (
            <div className={styles.apiKeyInput}>
              <input
                type="password"
                placeholder={t('apiKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                disabled={form.verifying}
                // 移动端打开设置时不弹键盘，点编辑后才聚焦
                autoFocus={!isMobile || editing}
                value={form.value}
                onChange={(event) => form.setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    void form.submit()
                  }
                }}
              />
              {!isMobile && form.value.trim() ? (
                <>
                  <span className={styles.divider} />
                  <button
                    type="button"
                    className={styles.confirm}
                    disabled={form.verifying}
                    // 保持输入框焦点
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void form.submit()}
                  >
                    {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                  </button>
                </>
              ) : null}
            </div>
          )}
          {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
        </div>
      </div>
      {openai && apiKey && !showInput ? (
        <div className={`${styles.cell} ${styles.row}`}>
          <div className={styles.text}>
            <div className={styles.label}>{t('openaiModelLabel')}</div>
          </div>
          <Select
            ariaLabel={t('openaiModelLabel')}
            value={model}
            options={(models.length ? models : model ? [model] : []).map((id) => ({
              value: id,
              label: id,
            }))}
            onChange={setOpenaiModel}
          />
        </div>
      ) : null}
    </>
  )
}

/** 移动端：输入 API Key 时在选项下方显示整行「确定」 */
export const ApiKeyConfirm = ({ editor: { showInput, form } }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  return showInput && form.value.trim() ? (
    <button
      type="button"
      className={styles.mobileConfirm}
      disabled={form.verifying}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void form.submit()}
    >
      {form.verifying ? t('apiKeyVerifying') : t('confirm')}
    </button>
  ) : null
}
