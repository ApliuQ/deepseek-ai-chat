import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setConnection, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState(() => useSettings.getState().apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(() => useSettings.getState().baseUrl)
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || !baseUrl.trim() || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      const url = new URL(baseUrl.trim())
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      ) {
        throw new Error(t('baseUrlInvalid'))
      }
      const models = await verifyApiKey(apiKey, baseUrl.trim())
      setConnection(apiKey, baseUrl, models)
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, baseUrl, setBaseUrl, verifying, error, submit }
}
