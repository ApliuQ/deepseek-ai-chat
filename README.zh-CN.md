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

OpenAI 模式支持流式对话、思考（`reasoning_effort: none/high`）、自动标题和内联图片。文本、DOCX、PPTX、XLSX 在本地提取后，首次只发送文件信息及前 10KB UTF-8 文本；XLSX 同时提供工作表名称和行数。较大文件提供本地 `read_file` 函数，支持字节偏移或工作表/A1 范围，按需从 IndexedDB 原件重新提取，刷新后仍可读取。限制为单次 16KB、范围 100×100 单元格、24 次调用、8 轮工具调用，以及累计 256KB 结果；小文件无需工具。PDF 最多渲染前 20 页为 JPEG，最长边 1536px，注明省略页数，渲染失败时回退到文字。未知或不可提取的二进制文件只发送名称、类型和大小，不发送 base64 内容。自定义模式拒绝超过 50MB 的附件，官方限制不变。

需要搜索且能力未知时，先探测 Chat 服务端搜索（必须返回 URL 引用），再探测 Responses 服务端搜索（必须返回已完成搜索项），按接口和模型缓存 24 小时。不支持或运行时失败则降级至免密 Exa MCP 搜索/网页读取，读取失败时使用 Jina Reader，绝不向第三方发送 API Key 或凭证。需要读取本地文件的轮次直接使用客户端工具循环，以便文件与搜索工具共存。搜索最多调用 3 次，失败时显示“当前模型不支持联网搜索：”及限长的真实错误和 HTTP 状态。Responses 搜索步骤、引用、思考摘要和用量沿用现有界面，伪工具标记会被剥除。自定义麦克风转写使用当前模型的 Chat `input_audio`（WAV/MP3），需上游支持音频输入；不显示朗读按钮。官方语音接口不变。

能力探测延迟到模型实际请求搜索工具时。能力未知时，首轮提供可选的客户端工具并立即流式输出；普通图片或文字回答不探测、不搜索。模型请求工具后才选择服务端搜索或执行客户端工具。已缓存的服务端路径也可以直接回答、不执行搜索。搜索状态仅来自实际工具事件或引用结果，不再由搜索开关或能力探测触发。

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
