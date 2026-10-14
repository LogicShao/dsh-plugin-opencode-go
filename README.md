# dsh-plugin-opencode-go

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 **OpenCode Go 套餐适配**的宿主侧插件：把会话头打到**所有**发往 Go 网关的请求上，并把 `web_search` 换成直连 Go 网关、模型一处可切的实现。

## 解决的两个问题

### 1. 会话头只覆盖了聊天，辅助请求漏掉了

OpenCode Go 的官方要求（<https://opencode.ai/docs/go> → *Where can I use it?*）：

> Your client should: 1. Send typical coding agent traffic 2. Identify itself with its own user agent 3. **Send a stable session ID in `x-opencode-session` for each conversation** so we can optimize routing and prompt caching.

同一页的 *Known problematic clients* 里点名了 DeepSeek Harness：

> **DeepSeek Harness** — Session information arrives on some model paths, but is missing on others. We recognize its native header; the remaining work is to send it across all adapters.

DSH 的**聊天**请求可以经 `llm/stream` 瀑布按会话注入（[`dsh-plugin-session-headers`](https://github.com/LogicShao/dsh-plugin-session-headers) 就是这么做的），但 **web_search 这类辅助请求**由各自 provider 直接 `fetch`，不经过瀑布——于是 Go 网关回 `400 Request is missing x-opencode-session`。本插件在进程级包装 `globalThis.fetch`，把会话头补到**每一条**发往 Go 网关的请求上：

- 聊天链路：从 `llm/stream` 的 `AsyncLocalStorage` store 取 `{ sessionId, provider, model }`；
- 辅助链路：回退顺序为 `agents.currentInitiator().session.id` → `DSH_SESSION_ID` → 进程级稳定 id；
- 只对 `config.hosts` 列出的主机生效（默认 `opencode.ai`），其它主机原样透传。

### 2. 搜索模型藏在别人的配置里

`web-search-deepseek` 的模型写在它自己的条目里，换模型要去改别的插件的 config，而且它默认指向 `api.deepseek.com`。本插件注册自己的 `web_search` 提供方直连 Go 网关：

- 模型在本插件配置里**一处切换**：`search.model`（写模型 id，或写 `'auto'` 跟随当前聊天模型）；
- 会话头由提供方显式带上，不依赖上面的 fetch 包装；
- 结果映射与内置提供方一致（`web_search_tool_result` → `sources`，文本块 `citations[].cited_text` → `snippet`，按 URL 去重）。

## 安装

```bash
# 本地目录开发安装（link:，改代码即生效）
dsh plugin --profile desktop add /path/to/dsh-plugin-opencode-go

# 从 GitHub 安装
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-opencode-go
```

包声明了 `dsh.bundle.patch`，安装命令会自动把它登记进 profile 的 `dsh.profile.bundles`。**bundle 层在启动时读取，装完需要重启 DSH。**

`link:` 安装的目录就是源码目录：改 `lib/index.js` 后重启即生效，不需要重新安装。

## 配置

插件的 bundle patch（`cordis.patch.yml`）已经给出可用默认值；要改就在 profile 层按 id 覆盖（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: opencode-go-adapter
  name: 'dsh-plugin-opencode-go'
  config:
    hosts: ['opencode.ai']            # 需要打会话头的主机
    headers:                          # 默认头模板
      x-opencode-session: '{sessionId}'
      x-deepseek-harness-session-id: '{sessionId}'
    routes:                           # 可选：按 llm/stream 路由 id 覆盖头模板
      opencode-go:
        x-opencode-session: '{sessionId}'
    chatProviders: ['opencode-go']    # 哪个路由算「聊天模型」（供 search.model: auto 跟随）
    onlyIfMissing: false              # true = 只在请求没带该头时才补
    patchFetch: true                  # false = 不动 globalThis.fetch（只保留搜索提供方）
    debug: 'D:\path\to\debug.log'     # 打开后每次请求/搜索写一行 JSON，排查用
    search:
      enabled: true
      provider: opencode-go           # 提供方 id，需与 web.searchProvider 一致
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: OPENCODE_GO_API_KEY  # 凭据引用（~/.dsh/.credentials.yaml 或启动环境）
      model: deepseek-v4.1-flash      # 或 'auto'：跟随当前聊天模型
      fallbackModel: deepseek-v4.1-flash  # 'auto' 还没见过聊天模型时的兜底
      anthropicVersion: '2023-06-01'
      maxTokens: 4096
      maxUses: 5
```

模板占位符：`{sessionId}`、`{provider}`、`{model}`。凭证解析顺序：`ctx.credentials` → `process.env[apiKeyEnv]`。

## 切换模型

三种都行，选一种：

| 想做的事 | 怎么改 |
|---|---|
| 搜索固定用某个 Go 模型 | `search.model: deepseek-v4.1-flash`（改这一行） |
| 搜索跟随聊天模型 | `search.model: 'auto'`，之后在 DSH 界面里换聊天模型即可，搜索自动跟随 |
| 只换聊天模型 | 用 DSH 自带的模型选择器（本插件不干预聊天模型） |

> `'auto'` 的代价：Go 上并非每个模型都支持 Anthropic 的**服务端** `web_search` 工具。实测（2026-10，Go 套餐）：
> `deepseek-v4.1-flash` ✅、`claude-haiku-5-5` ✅、`minimax-m3` ⚠️ 时好时坏。
> 跟随到的模型不支持检索时，搜索会以 `没有返回 web_search_tool_result 块` 失败，此时把 `search.model` 固定成一个支持检索的模型即可。

## 工作原理

1. `apply()` 用 `ctx.effect` 包装 `globalThis.fetch`（`Symbol.for` 标记防重复，dispose 时仅当仍是自己的包装才还原）；
2. 监听 `llm/stream` 瀑布，把 `{ provider, sessionId, model }` 放进 `AsyncLocalStorage`，并把返回的 async generator 包一层，使**每一次** `next/return/throw` 都在该 store 内执行（返回值是惰性迭代器，只包外层无效）——pi-ai 每次请求新建客户端，SDK 在调用 fetch 时才取当时的全局 `fetch`，因此恰好生效；
3. 包装后的 fetch 命中 `hosts` 时，按 `routes[provider] ?? headers` 渲染模板并 `Headers.set`；
4. `ctx.inject(['web'], …)` 等 web 服务就绪后注册搜索提供方（等价于内置插件的 `inject: ['web']`；直接访问 `ctx.web` 会在挂载顺序不利时被静默跳过，搜索端只看到 `configured web provider "…" is not registered`）。

## 与 dsh-plugin-session-headers 的关系

- 本插件已覆盖 Go 路由的会话头（含搜索等辅助请求），只用 Go 的话可以不再装 `session-headers`；
- 两个插件都包装 `fetch`，会互相链式包装（各自只还原自己的那一层），同时装着不会冲突；
- 搜索提供方只有本插件提供；`web.searchProvider` 由本插件的 bundle patch 指向 `opencode-go`，要换回内置的 DeepSeek 官方提供方，在 profile 层覆盖 `- id: web` 的 `config.searchProvider` 即可。

## 兼容性

- 不 `import` 任何 `@deepseek-ai/*` 包，不声明 `peerDependencies`，无运行时依赖（只用 `node:async_hooks` / `node:fs` / `node:os` / `node:path`）；
- 挂钩契约四处：`llm/stream` 事件名与其 `options.provider/sessionId/model` 字段、`ctx.inject(['web'])`、`ctx.web.registerSearchProvider(provider)`、`ctx.get('credentials').resolve(ref)`；
- 上游变更时插件会退化为「不注入、不注册」（`ctx.logger.warn`），不会让 DSH 起不来。

## 已知限制

- 只对 `hosts` 列出的主机注入；模型发现等其它链路若不发往这些主机则不受影响；
- 搜索提供方只说 Anthropic Messages 协议（Go 的 `/messages` 路由），不支持 OpenAI 兼容路由；
- `maxResults` 由 web seam 事后截断，`truncated` 恒为 `false`（与内置提供方一致）；
- 未引用的结果没有 `snippet`（只有命中 `citations[].cited_text` 的 URL 才有）。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-opencode-go
```

卸载后 `globalThis.fetch` 由 effect disposer 还原，`web.searchProvider` 需改回内置提供方（否则搜索会报 provider 未注册）。

## 开发与测试

```bash
node test/mechanism.test.mjs   # 30 项断言，无需安装任何依赖
```

用轻量 ctx 桩 + fetch 桩驱动，覆盖：聊天链路会话头注入、辅助请求的环境变量回退、非 Go 主机透传、路由级模板覆盖、搜索请求形状（端点/凭据/会话头/工具定义）、响应映射（snippet、publishedAt、去重、truncated）、`search.model` 写死与 `'auto'` 跟随、无检索块与 HTTP 错误的报错、无会话来源时的进程级兜底、`ctx.inject` 延迟注册、dispose 还原 fetch。

## License

MIT
