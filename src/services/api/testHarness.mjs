import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { DOMParser } from '@xmldom/xmldom'
import { zh } from '../../i18n/zh.ts'

export const loadApi = async ({
  fetch = globalThis.fetch,
  pdfjs,
  clientSource,
  storage,
  document,
  locale = zh,
} = {}) => {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Blob,
    File,
    FormData,
    btoa,
    DOMParser,
    document,
    AbortController,
    ReadableStream,
    setTimeout,
    clearTimeout,
    localStorage: storage ?? { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    __API_ORIGIN__: 'https://api.deepseek.com',
    fetch,
  })
  const modules = new Map()
  const stub = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) {
          this.setExport(key, value)
        }
      },
      { context }
    )
  const external = async (specifier) => {
    if (specifier === 'pdfjs-dist' && pdfjs) {
      return stub(pdfjs)
    }
    return stub(await import(specifier))
  }
  const resolve = async (specifier, parent) => {
    if (specifier.includes('/i18n/')) {
      return stub({
        translate: (key, params) =>
          key.startsWith('custom') && locale[key]
            ? locale[key].replace(
                /\{(\w+)\}/g,
                (placeholder, name) => params?.[name] ?? placeholder
              )
            : key,
      })
    }
    if (specifier.includes('resizeUploadImage')) {
      return stub({ resizeUploadImage: (file) => file, isUploadImageOversized: async () => false })
    }
    if (!specifier.startsWith('.')) {
      return external(specifier)
    }
    const url = new URL(specifier.replace(/\.js$/, '.ts'), parent)
    return compile(url)
  }
  const compile = (url) => {
    if (modules.has(url.href)) {
      return modules.get(url.href)
    }
    const source =
      url.href.endsWith('/client.ts') && clientSource ? clientSource : readFileSync(url, 'utf8')
    const module = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {
      context,
      identifier: url.href,
      initializeImportMeta: (meta) => {
        meta.url = url.href
      },
      importModuleDynamically: async (specifier, parent) => {
        const dependency = await resolve(specifier, parent.identifier)
        if (dependency.status === 'unlinked') {
          await dependency.link((child, source) => resolve(child, source.identifier))
        }
        if (dependency.status === 'linked') {
          await dependency.evaluate()
        }
        return dependency
      },
    })
    modules.set(url.href, module)
    return module
  }
  const openai = compile(new URL('./openai.ts', import.meta.url))
  await openai.link((specifier, parent) => resolve(specifier, parent.identifier))
  await openai.evaluate()
  const speech = compile(new URL('./speech.ts', import.meta.url))
  await speech.link((specifier, parent) => resolve(specifier, parent.identifier))
  await speech.evaluate()
  const models = compile(new URL('./models.ts', import.meta.url))
  await models.link((specifier, parent) => resolve(specifier, parent.identifier))
  await models.evaluate()
  const dialog = compile(
    new URL('../../components/settings/settingsDialogState.ts', import.meta.url)
  )
  await dialog.link((specifier, parent) => resolve(specifier, parent.identifier))
  await dialog.evaluate()
  const upload = compile(new URL('../attachments.ts', import.meta.url))
  await upload.link((specifier, parent) => resolve(specifier, parent.identifier))
  await upload.evaluate()
  const attachments = modules.get(new URL('./openaiAttachments.ts', import.meta.url).href)
  const settings = modules.get(new URL('../settings.ts', import.meta.url).href)
  const client = modules.get(new URL('./client.ts', import.meta.url).href)
  return {
    ...upload.namespace,
    ...modules.get(new URL('./openaiFiles.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./browserWeb.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./customRequest.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./openaiSearch.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./openaiClientSearch.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./openaiResponses.ts', import.meta.url).href)?.namespace,
    ...modules.get(new URL('./openaiSearchCapabilities.ts', import.meta.url).href)?.namespace,
    ...openai.namespace,
    ...attachments.namespace,
    ...settings?.namespace,
    ...client.namespace,
    ...speech.namespace,
    ...models.namespace,
    ...dialog.namespace,
  }
}

export const sseBody = (text) =>
  new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text)
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7))
      }
      controller.close()
    },
  })

export const collect = async (events) => {
  const result = []
  for await (const event of events) {
    result.push(event)
  }
  return JSON.parse(JSON.stringify(result))
}
