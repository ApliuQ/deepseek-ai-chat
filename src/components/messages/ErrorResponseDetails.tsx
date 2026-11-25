import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { ResponseDetails } from '../../services/api/responseDetails.js'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import styles from './ReplyArea.module.css'

export const ErrorResponseDetails = ({ details }: { details: ResponseDetails }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.area}>
      <button
        type="button"
        className={styles.errorDetailsToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.titleText}>{t('customResponseDetails')}</span>
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      </button>
      {open ? (
        <div className={styles.errorDetails}>
          {details.status === undefined ? null : <div>HTTP {details.status}</div>}
          <pre>{details.body}</pre>
          {details.truncated ? <div>{t('customResponseTruncated')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
