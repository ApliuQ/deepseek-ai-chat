# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## API 基础地址、OpenAI 兼容模式与嵌入

在设置 → 数据管理中一起修改 API 基础地址和 API Key，确认校验成功后才会保存。默认地址是 `https://api.deepseek.com`，使用原有 DeepSeek 接口；其他地址启用 OpenAI 兼容模式（如 NewAPI）。地址末尾没有版本段时自动补 `/v1`。校验要求 `/models` 返回 JSON 模型列表。在聊天输入框右下角的下拉框中单选模型，列表按名称排序并自动刷新，选择结果会保存。

OpenAI 模式支持流式对话、思考（`reasoning_effort`：关闭为 `none`，开启为 `high`）、自动标题、内联图片、UTF-8/GB18030 文本，以及本地提取 DOCX、PPTX、PDF 和 XLSX 文字。提取结果包含文件名，超过 1 MiB 时截断并注明；XLS 和其他不支持的二进制附件会显示说明，不再发送上游可能忽略的 base64 文件部分。XLSX 解析按需加载、异步解压，并限制解压大小与单元格数量。开启搜索后，`web_search` 和 `fetch_url` 使用无需密钥的 Exa 托管 MCP；网页读取失败时回退至 Jina Reader，均不携带模型服务的凭据。最多执行三次工具调用、三轮续答，沿用搜索结果和引用界面。错误与限流会显示在正文中并反馈给模型。公共服务有免费额度和可用性限制；搜索词及待读取的 URL 会发送给这些服务。语音功能需要 `whisper-1` 和 `tts-1` 的访问权限，音色映射为 nova/onyx。

可用 iframe 嵌入应用。没有缓存连接时，默认地址为嵌入父页面的 origin 加 `/v1`（优先 `ancestorOrigins`，否则尝试 referrer）。直连或嵌入时都可用 `?baseUrl=https%3A%2F%2Fgateway.example%2Fv1`（也支持 `base_url`）覆盖未缓存的默认值；之后访问优先复用已校验保存的连接。API 必须允许浏览器 CORS 请求；若浏览器或 referrer 策略隐藏父页面来源，则回退到构建默认地址。请仅在可信父页面中嵌入，并在输入 API Key 前确认目标地址。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
