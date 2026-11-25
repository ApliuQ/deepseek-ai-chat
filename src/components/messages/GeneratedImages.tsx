import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import type { GeneratedImage, ImageGenerationBlock } from '../../services/api/types.js'
import { loadFile } from '../../services/chat/db.js'
import { IconDownloadOutline16, IconPhotoErrorFill20 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { useFileView } from '../files/useFileView.js'
import styles from './GeneratedImages.module.css'

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 电脑端直接下载；手机端优先调起系统分享面板（可选「存储图像」存到相册），不支持时退回下载 */
const saveImage = async (image: GeneratedImage, mobile: boolean) => {
  const blob = await loadFile(image.fileId)
  if (!blob) {
    return
  }
  const file = new File([blob], image.name, { type: image.mimeType })
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
    }
  }
  download(file, image.name)
}

const ImageItem = ({ image }: { image: GeneratedImage }) => {
  const t = useTranslate()
  const mobile = useIsMobile()
  const view = useFileView(image.fileId, image.name)
  return (
    <figure className={styles.item} style={{ aspectRatio: `${image.width} / ${image.height}` }}>
      {view?.url ? (
        <a href={view.url} target="_blank" rel="noreferrer">
          <img src={view.url} alt={image.name} width={image.width} height={image.height} />
        </a>
      ) : view ? (
        <div className={styles.placeholder} title={t('imageUnavailable')}>
          <IconPhotoErrorFill20 />
        </div>
      ) : (
        <div className={styles.placeholder} />
      )}
      <div className={styles.actions}>
        <IconButton
          icon={<IconDownloadOutline16 />}
          tooltip={t(mobile ? 'imageSave' : 'imageDownload')}
          onClick={() => void saveImage(image, mobile)}
        />
      </div>
    </figure>
  )
}

/** 图片工具结果：生成中显示占位，完成后显示图片与下载 / 保存按钮 */
export const GeneratedImages = ({ block }: { block: ImageGenerationBlock }) => {
  const t = useTranslate()
  const wip = block.status === 'wip'
  const pending = wip ? Math.max(0, block.count - block.images.length) : 0
  const [w, h] = block.aspectRatio.split(':').map(Number)
  const ratio = w && h ? `${w} / ${h}` : '1 / 1'
  return (
    <div className={styles.block}>
      {wip ? (
        <div className={styles.status}>
          {t(block.tool === 'edit_image' ? 'imageEditing' : 'imageGenerating')}
          {block.count > 1 ? ` ${block.images.length}/${block.count}` : ''}
        </div>
      ) : null}
      {block.status === 'failed' || (!wip && block.error) ? (
        <div className={styles.error}>
          {t('imageFailed')}
          {block.error ? `：${block.error}` : ''}
        </div>
      ) : null}
      {block.images.length || pending ? (
        <div className={styles.grid}>
          {block.images.map((image) => (
            <ImageItem key={image.fileId} image={image} />
          ))}
          {Array.from({ length: pending }, (_, index) => (
            <div
              key={`pending-${index}`}
              className={`${styles.item} ${styles.loading}`}
              style={{ aspectRatio: ratio }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
