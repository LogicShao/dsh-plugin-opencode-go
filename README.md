# dsh-plugin-opencode-go

[![test](https://github.com/LogicShao/dsh-plugin-opencode-go/actions/workflows/test.yml/badge.svg)](https://github.com/LogicShao/dsh-plugin-opencode-go/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 **OpenCode Go 套餐适配**的宿主侧插件：把会话头打到**所有**发往 Go 网关的请求上，把 `web_search` 换成直连 Go 网关、模型一处可切的实现，并为 fake-ip / 透明代理环境补上一个能用的 `web_fetch`。

## 快速开始

DSH Desktop：侧栏 **插件** → **添加插件** → **安装第三方插件**，粘贴：

```text
github:LogicShao/dsh-plugin-opencode-go
```

装完点 **立即启用**，**重启 DSH**；再按 [安装](#安装) 里的「安装后」填 `OPENCODE_GO_API_KEY`。
命令行等价写法：

```bash
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-opencode-go
```

## 解决的三个问题

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
- **两个开关**：`search.modelFallback` 控制 Go 内部是否换模型重试，`search.officialFallback` 控制 Go 全失败后是否改用官方 DeepSeek 兜底（默认关，按官方 API 计费）；
- **主模型不检索就自动回退**：Go 上有的模型会静默吞掉服务端 `web_search` 工具、只回一段「我没法联网」，有的干脆不认 Messages 协议（HTTP 400），还有的地区受限直接 403。`search.fallbackModels` 给出回退链，主模型没出结果就依次重试（见「实测：可用性与成本」）；
- **不漏掉能力信号**：某模型被证实不执行检索后，在 `noSearchCacheMinutes`（默认 30）内优先跳过它，后续搜索不再白跑一轮；
- **关掉插件就回到原始 DSH 配置**（见「开关与关闭行为」）；
- 会话头由提供方显式带上，不依赖上面的 fetch 包装；
- 结果映射与内置提供方一致（`web_search_tool_result` → `sources`，文本块 `citations[].cited_text` → `snippet`，按 URL 去重）。

### 3. 抓取被 fake-ip 挡住（`resolves to a non-public IP address`）

DSH 内置的 `web-fetch-http` 在连接前自己解析域名，并要求整组 A/AAAA 答案都是**公网 unicast**。代理软件的 fake-ip 会把域名解析到保留段（Clash / mihomo 默认 `198.18.0.0/15` 与 `fc00::/7`），于是 `web_fetch` 在发请求之前就失败：

```
Error: URL hostname "github.com" resolves to a non-public IP address
```

而同一台机器上的浏览器、`curl`、普通 `fetch` 都能打开——路由器把假 IP 透明转发到了真正的上游，只有这道「解析结果必须是公网」的校验过不去。本插件注册自己的抓取提供方（`opencode-go-fetch`）绕开该解析校验，但保留三道本地检查与全部上限：

- 协议只允许 http(s)，URL 里不许带凭据；
- **非公网 IP 字面量默认拒绝**（`127.0.0.1`、`10.x`、`192.168.x`、`169.254.169.254`、`[::1]`、`198.18.x`……），重定向的每一跳都重新校验——要访问内网调试服务得显式打开 `fetch.allowIpLiterals`；
- 字节 / 字符 / 重定向 / 超时上限与内置提供方一致（默认 5 MB、100k 字符、5 跳、30s），HTML 原样返回，由 `dsh-tool-web` 转 markdown。

代价：域名**不再**要求解析到公网地址（这正是修 fake-ip 的方式），因此一个能解析到内网的域名仍可能被 `web_fetch` 打开；只在信任自己网络的前提下使用。

## 安装

### 前置条件

- DSH Desktop **44.7.0**（runtime `0.2.1-rc.2`）或兼容版本；升级过 DSH 就先跑 `node tools/compat-check.mjs`（见「兼容性」）。
- 一个 OpenCode Go 的 API key，下面用 `OPENCODE_GO_API_KEY` 引用。
- 不需要单独装 Node/pnpm：DSH 自带运行时；只有本地开发才需要 Node ≥ 22.19。

### 方式 A：Web 插件页（推荐）

1. 侧栏 **插件** → **添加插件** → **安装第三方插件**。
2. 粘贴：

   ```text
   github:LogicShao/dsh-plugin-opencode-go
   ```

3. 安装完成点 **立即启用**，然后**完全退出并重启 DSH**（bundle 层只在启动时读取）。

### 方式 B：`dsh plugin` CLI

```bash
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-opencode-go
```

### 方式 C：本地源码

```bash
git clone https://github.com/LogicShao/dsh-plugin-opencode-go.git
dsh plugin --profile desktop add ./dsh-plugin-opencode-go
```

`link:` 安装的目录就是源码目录：改 `lib/index.js` 后重启即生效，不需要重新安装。

包声明了 `dsh.bundle.patch`，安装命令会自动把它登记进 profile 的 `dsh.profile.bundles`；不需要手工编辑
`package.json`。**bundle 层在启动时读取，装完需要重启 DSH。**

### 安装后：配置 provider 与默认模型

插件接管的是会话头、`web_search`、`web_fetch`。`opencode-go` 这个 LLM provider 的密钥和默认模型仍在 profile 层配置——在
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里加：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

然后设置密钥，二选一：

- 启动 DSH → 设置 → 模型 → `opencode-go` → 填 API key；
- 或者设系统环境变量 `OPENCODE_GO_API_KEY`（也可以写进 `~/.dsh/.credentials.yaml` 的 `refs`）后重启。

`deepseek-v4.1-flash` 不在目标 DSH 的模型目录里时，换成实际存在的模型；或者删掉 `agent-default-model`，在 UI 里选。
插件 bundle 已经自带搜索 / 抓取 / 会话头的默认配置，不需要再抄一遍；要改搜索模型或回退链，看下面的「配置」。

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
      provider: opencode-go           # 提供方 id，需与 web.searchProvider 一致
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: OPENCODE_GO_API_KEY  # 凭据引用（~/.dsh/.credentials.yaml 或启动环境）
      model: claude-haiku-5-5         # 默认：单价低 + 自带摘要；或 'auto'：跟随当前聊天模型
      modelFallback: true             # 开关 1：Go 内部换模型重试
      fallbackModels:                 # 主模型没返回检索结果时按顺序重试
        - minimax-m3.1-flash-free
        - deepseek-v4-pro
      officialFallback: false         # 开关 2：Go 全失败后改用官方 DeepSeek 兜底
      officialBaseURL: https://api.deepseek.com/anthropic/v1
      officialApiKeyEnv: DEEPSEEK_API_KEY
      officialModel: deepseek-v4-flash
      noSearchCacheMinutes: 30        # 记住「不检索」的模型多久；0 = 关闭缓存
      anthropicVersion: '2023-06-01'
      maxTokens: 4096
      maxUses: 5
    fetch:
      provider: opencode-go-fetch    # 提供方 id，需与 web.fetchProvider 一致
      maxResponseBytes: 5000000      # 响应字节上限
      maxBodyChars: 100000           # 解码后的字符上限
      timeoutMs: 30000               # 单次抓取超时
      maxRedirects: 5                # 重定向跳数；0 = 不跟随（允许跨域，但每一跳都重新校验）
      allowIpLiterals: false         # true = 放行 127.0.0.1 / 192.168.x 等字面量（内网调试）
      userAgent: 'dsh-plugin-opencode-go/0.2.0 (+https://github.com/LogicShao/dsh-plugin-opencode-go)'
```

模板占位符：`{sessionId}`、`{provider}`、`{model}`。凭证解析顺序：`ctx.credentials` → `process.env[apiKeyEnv]`。

## 开关与关闭行为

两个开关互相独立：

| 开关 | 默认 | 打开时 | 关掉时 |
|---|---|---|---|
| `search.modelFallback` | `true` | Go 内部按 `fallbackModels` 依次重试 | 只试 `search.model`，失败即报错 |
| `search.officialFallback` | `false` | Go 全部失败后，用官方 DeepSeek 再搜一次 | Go 失败就失败，不碰官方 API |

官方兜底的鉴权顺序和内置搜索一致：**账号登录态优先**（`ctx.get('deepseekAccount').resolveToken()`，发 `x-dsh-auth-token`），拿不到才退回 `officialApiKeyEnv` 指向的 API key。所以只登录 DeepSeek 账号、不配 API key 也能兜底；反过来，连 Go 凭据都没有时（比如套餐到期删了 key），开了 `officialFallback` 也会跳过 Go 直接走官方。注意官方搜索偶发返回 `error_code=unavailable`（上游临时不可用），这时会作为失败原因写进报错里。

**关闭插件 = 回到原始 DSH 配置**，机制是「指向与插件同属一个 bundle 层」：`cordis.patch.yml` 里那行 `- id: web`（`searchProvider: opencode-go` + `fetchProvider: opencode-go-fetch`）和插件本体在同一个 bundle 里，你在插件管理页关掉整个插件时两行一起消失，`web` 自动回到 base 的 `deepseek-official`（搜索）与 `http`（抓取）。插件卸载时还会主动把自己的两个提供方从 seam 里摘掉，不留残余。

⚠️ 两个不要：**别只关插件行而保留 bundle 层**，也**别把 `- id: web` 抄进 profile**——那会留下一个指向 `opencode-go` / `opencode-go-fetch` 的悬空引用，搜索与抓取会报 `WEB_PROVIDER_CONFIGURED_MISSING`。

## 没有插件页表单

本包只在宿主半侧工作，**不提供插件页配置入口**：DSH 插件页只渲染由浏览器半侧（`dsh.client` + `exports["./client"]`）注册的 slot，而本包没有浏览器半侧。下面这些字段全部在 `cordis.patch.yml` 里改，改完重启 DSH 生效：

| 字段 | 含义 |
|---|---|
| `search.model` | 搜索主模型 |
| `search.modelFallback` | 开关 1：Go 内部换模型重试 |
| `search.fallbackModels` | 回退链顺序 |
| `search.officialFallback` | 开关 2：Go 全挂后改用官方 DeepSeek |
| `search.officialBaseURL` / `officialApiKeyEnv` / `officialModel` | 官方兜底的目标与凭据 |
| `search.officialMaxTokens` / `officialMaxUses` | 官方兜底的预算 |
| `search.maxTokens` / `maxUses` | Go 搜索的预算 |
| `search.noSearchCacheMinutes` | 「不检索」记忆时长 |
| `hosts`、`headers`、`routes`、`chatProviders`、`debug`、`anthropicVersion`、`fetch.*` | 其余结构字段，同样只在 YAML 里改 |

`Config` 仍然声明了，`dsh-settings` 会投影字段描述符并做写入校验；但官方说明里「按 schema 自动生成页面」至今没有已发布的客户端实现，所以页面上没有对应界面。

## 切换模型

| 想做的事 | 怎么改 |
|---|---|
| 用默认（便宜 + 有摘要） | `search.model: claude-haiku-5-5`（就是默认值，无需配置） |
| 追求 $0 成本 | `search.model: minimax-m3.1-flash-free`（免费不限量，但没有 `snippet` 摘要） |
| 搜索跟随聊天模型 | `search.model: 'auto'`，之后在 DSH 界面里换聊天模型即可；聊天模型不检索时自动落到 `fallbackModels` |
| 不满意默认优先级 | 调 `search.fallbackModels` 的顺序，或用 `modelFallback: false` 整体关掉 |
| 想要断网级兜底 | `officialFallback: true`（Go 挂了也能搜，按官方 API 计费） |
| 只换聊天模型 | 用 DSH 自带的模型选择器（本插件不干预聊天模型） |

## 实测：可用性与成本

> 2026-10-20，Go 套餐（$10/月，额度按 token 折算成美元，单价见 <https://opencode.ai/docs/go> → *Usage limits*）。
> 请求形态 `POST /zen/go/v1/messages` + `tools:[{type:'web_search_20250305'}]`，单次查询实测。

| 模型 | 可用性 | 单次成本 | 耗时 | 摘要 | 额度 |
|---|---|---|---|---|---|
| `minimax-m3.1-flash-free` | ✅ 16–49 条 | **$0**（免费） | 7.5–33s | ❌ 无 | 不限量（限时免费） |
| `claude-haiku-5-5` | ✅ 9 条 | **$0.0020** | 8.4–10s | ✅ 5/9 条 | $15/月 ≈ 7,400 次 |
| `deepseek-v4-pro` | ✅ 10 条 | $0.0090 | 17–19s | ❌ 无 | $15/月 ≈ 1,700 次 |
| `kimi-k3` | ✅ 7–9 条 | $0.0207 | 26–41s | ❌ 无 | $15/月 ≈ 700 次 |
| `deepseek-v4.1-flash` | ❌ 不检索 | — | ~10s | — | 0.1.0 的默认值，也是最初报错的直接原因 |
| `qwen3.8-max` / `qwen3.8-flash` / `qwen3.7-plus` / `minimax-m3` | ❌ 不检索 | — | 10–34s | — | 同样静默吞掉工具 |
| `glm-*` / `gpt-*` / `grok-*` / `mimo-*` / `hy3` / `longcat-2.0` / `kimi-k2.7-code` / `step-5-preview` / `longcat-2.5-preview-free` | ⛔ HTTP 400 | — | — | — | `ModelProtocolUnsupported`，不认 Messages 协议 |
| `beam-free` / `muse-spark-1.2-1.3` | ⛔ HTTP 403 | — | — | — | `RegionError`，所在地区不可用 |

**为什么默认用 haiku 而不是那个免费模型**：免费档确实 $0，但它不返回 `citations`，结果里没有 `snippet`（只有标题 + URL），代理往往要多抓几个页面才敢下结论——那部分花的是聊天模型的 token，通常比 haiku 的 $0.002/次更贵。haiku 每次搜索自带 5 条左右的原文摘录，额度也够 7,400 次/月。

想压到绝对 $0 就把 `search.model` 换成 `minimax-m3.1-flash-free`；它限时免费，撤掉后回退链会自动接上 haiku。

两种失败模式要分开看：**❌ 静默不检索**（HTTP 200，只是没有 `web_search_tool_result` 块）和 **⛔ 协议/地区不支持**（HTTP 400/403）。插件对两者都按「换下一个候选模型」处理；只有 401/403 里的**凭据**问题会立刻失败（`RegionError` 也是 403，但它同样会走回退）。

## 排查

报错 `响应里没有 web_search_tool_result 块（stop_reason=...），说明该模型没有执行服务端 web_search` 的意思是：**请求发出去了、模型也答了，但它没执行检索工具**。按顺序检查：

1. `search.model` 是不是落在了「❌ 不检索」那一档（常见于写成 `'auto'`、而聊天模型正好是 `deepseek-v4.1-flash`）；
2. 把 `search.fallbackModels` 留成默认的，或直接固定 `search.model: claude-haiku-5-5`；
3. 想在日志里看到每次尝试用了哪个模型、为什么被跳过，把 `debug:` 指到一个文件路径，会写 `search` / `search-no-result` 事件。

开启 `debug` 后，一次失败的回退链日志长这样：

```json
{"event":"search","model":"deepseek-v4.1-flash","attempt":0,...}
{"event":"search-no-result","model":"deepseek-v4.1-flash","code":"no-search","message":"响应里没有 web_search_tool_result 块（stop_reason=max_tokens，块类型=[thinking]）…"}
{"event":"search","model":"claude-haiku-5-5","attempt":1,...}
```

抓取侧的报错：

| 报错码 | 含义 | 怎么办 |
|---|---|---|
| `WEB_BLOCKED_URL`（`non-public IP literal`） | 目标是内网 IP 字面量，默认拒绝 | 换域名；确实要访问内网就设 `fetch.allowIpLiterals: true` |
| `WEB_UNSUPPORTED_CONTENT_TYPE` | 二进制响应（PDF/图片），或无法识别的 charset | 与内置提供方一致，不支持的格式没有正文可给 |
| `WEB_FETCH_TOO_LARGE` | `Content-Length` 超过 `fetch.maxResponseBytes` | 调高上限，或换更精确的页面 |
| `WEB_REDIRECT_BLOCKED` | 重定向超过 `fetch.maxRedirects`，或跳到了被拒的目标 | 提高上限，或直接抓最终 URL |
| `WEB_FETCH_TIMEOUT` | 超过 `fetch.timeoutMs` | 调高超时；工具侧还有一层 30s 预算 |

## 工作原理

1. `apply()` 用 `ctx.effect` 包装 `globalThis.fetch`（`Symbol.for` 标记防重复，dispose 时仅当仍是自己的包装才还原）；
2. 监听 `llm/stream` 瀑布，把 `{ provider, sessionId, model }` 放进 `AsyncLocalStorage`，并把返回的 async generator 包一层，使**每一次** `next/return/throw` 都在该 store 内执行（返回值是惰性迭代器，只包外层无效）——pi-ai 每次请求新建客户端，SDK 在调用 fetch 时才取当时的全局 `fetch`，因此恰好生效；
3. 包装后的 fetch 命中 `hosts` 时，按 `routes[provider] ?? headers` 渲染模板并 `Headers.set`；
4. `ctx.inject(['web'], …)` 等 web 服务就绪后注册搜索提供方（等价于内置插件的 `inject: ['web']`；直接访问 `ctx.web` 会在挂载顺序不利时被静默跳过，搜索端只看到 `configured web provider "…" is not registered`）；
5. 同一时机再注册抓取提供方：不做 DNS 公网解析校验，逐跳校验重定向，按字节/字符截断，错误统一翻成 seam 词表（`WEB_*`）。

## 与 dsh-plugin-session-headers 的关系

- 本插件已覆盖 Go 路由的会话头（含搜索等辅助请求），只用 Go 的话可以不再装 `session-headers`；
- 两个插件都包装 `fetch`，会互相链式包装（各自只还原自己的那一层），同时装着不会冲突；
- 搜索与抓取提供方只有本插件提供；`web.searchProvider` / `web.fetchProvider` 由本插件的 bundle patch 指向 `opencode-go` / `opencode-go-fetch`，关掉整个插件就自动回到内置的 DeepSeek 官方搜索与本地 `http` 抓取。

## 兼容性

**已核对版本：DSH `0.2.1-rc.2`，cordis `4.0.5`。** 插件不 `import` 任何 `@deepseek-ai/*` 包，也不声明 `peerDependencies`，只按下面这几处符号挂钩，所以兼容性就取决于它们是否还在。

| 契约 | 宿主实现（0.2.1-rc.2） | 插件用法 | 变了会怎样 |
|---|---|---|---|
| `ctx.inject(deps, cb)` | cordis `Context.inject` | 等 `web` 服务就绪再注册 | 退化为不注册（仅告警） |
| `ctx.effect(fn, label)` | cordis `Fiber.effect` | 包装 / 还原 `globalThis.fetch` | 不注入会话头（仅告警） |
| `llm/stream` 瀑布 | `dsh-llm`：`ctx.waterfall(this, 'llm/stream', options, …)` | 取 `options.{provider,model,sessionId}` | `search.model: 'auto'` 失效、聊天请求会话头回退到 env/进程 id |
| `GenerateOptions.sessionId` | `dsh-llm` 类型声明 | 会话头来源 | 同上 |
| `ctx.web.registerSearchProvider(provider)` | `dsh-web` `WebRuntime` | provider = `{ id, available(), search(request, signal) }`；配置不再指向本插件时 `available()` 返回 false 自动让路 | 搜索不可用（仅告警） |
| `ctx.web.registerFetchProvider(provider)` | `dsh-web` `WebRuntime` | provider = `{ id, available(), fetch(request, signal) }`，返回 `{ url, statusCode, body, truncated }` | 抓取退回内置 `http`（仅告警） |
| `web.searchProvider` / `web.fetchProvider` 配置字段 | `dsh-web` 的 `static Config` | bundle 层把选择指向 `opencode-go` / `opencode-go-fetch` | 搜索/抓取退回内置或报 `WEB_PROVIDER_*` |
| `ctx.credentials.resolve(ref)` | `dsh-credentials-local` | 取 `OPENCODE_GO_API_KEY` | 回退到环境变量，都没有则报凭据缺失 |
| `agents.currentInitiator()` | `dsh-agent` | 辅助请求的会话 id | 回退到 `DSH_SESSION_ID` / 进程 id |

### 升级后先跑自检

```bash
node tools/compat-check.mjs                      # 自动找常见安装位置的 app.asar
node tools/compat-check.mjs /path/to/app.asar    # 指定安装包（或解包目录）
DSH_APP_ASAR=/path/to/app.asar node tools/compat-check.mjs
```

它不进 DSH 进程，只读安装包源码：打印各包版本 + 25 条契约的 ✅/❌，有不符合项就以退出码 `1` 结束。在当前安装上的结果：

```
dsh 0.2.1-rc.2 / cordis 4.0.5 … 25/25 项契约仍在，当前 DSH 版本可直接用本插件。
```

### 升级时容易踩的点

1. **web 工具的 30s 超时**：`dsh-tool-web` 默认 `searchTimeoutMs: 30000`，插件收到的 `signal` 就是它。回退链总耗时必须在这之内（haiku ~9s + 免费档 ~10s 够用；`kimi-k3` 单次就 40s+，别放前面）。要放宽就在 profile 层覆盖 `- id: tool-web` 的 `config.searchTimeoutMs`。
2. **一次 `web_search` 可能并发出 4 次搜索**：`searchMaxQueries: 4`，所以成本和耗时上限是单次搜索的 4 倍；结果再由 `searchMaxResults: 8` 截断。按次算钱的模型要留意。
3. **HMR 重复注册**：0.2 的 `registerSearchProvider` 把注册记在 **web 服务**的 fiber 上（不是插件自己的），插件热重载时旧注册不会释放，直接再注册会抛 `WEB_DUPLICATE_PROVIDER`。插件已加固：先摘掉同 id 旧条目再挂新的；拿不到注册表就告警并保留旧实现（重启后生效）。
4. **`truncated` 归 seam 管**：0.2 起 `web.search()` 会按 `maxResults` 截断 `sources[]` 并置 `truncated: true`；插件自己恒返回 `false` 是正常设计。
5. **错误码只做到 `code` 级**：插件抛的是普通 `Error`（不是 `WebError` 实例），但带上了 seam 词汇：`WEB_PROVIDER_ERROR` / `WEB_ABORTED` / `WEB_PROVIDER_CREDENTIAL_MISSING`，钩子或 UI 按 `error.code` 路由可用。
6. **fetch 包装的边界**：依赖「`llm-pi-ai` 用全局 `fetch`」这一事实（0.2 仍如此）。若某天编排器换 SDK 不再走全局 fetch，聊天链路的会话头会失效——搜索提供方不受影响（它自己带 header）。0.2 已支持 `llm-pi-ai.providers.<id>.headers`，可作为聊天链路的官方替代方案。
7. **`fetch` 与 `search` 是两套独立配置**：`web.fetchProvider` 必须等于 `fetch.provider`（默认 `opencode-go-fetch`），改了一边没改另一边会报 `WEB_PROVIDER_CONFIGURED_MISSING`。插件导出了 `Config`，但 `fetch.*` 是普通字段，且本插件没有插件页表单，只在 `cordis.patch.yml` 里改。

## 已知限制

- 只对 `hosts` 列出的主机注入；模型发现等其它链路若不发往这些主机则不受影响；
- 搜索提供方只说 Anthropic Messages 协议（Go 的 `/messages` 路由），不支持 OpenAI 兼容路由；
- `maxResults` 由 web seam 事后截断（0.2 起 seam 会置 `truncated: true`），插件自己恒返回 `false`；
- 未引用的结果没有 `snippet`（只有命中 `citations[].cited_text` 的 URL 才有）；
- 抓取不再要求域名解析到公网 IP（fake-ip 场景的必要让步）：能解析到内网的**域名**仍可能被 `web_fetch` 打开，只有 IP 字面量会被拦；
- 抓取的重定向语义与内置不同：允许跨域跟随（内置只跟同源），上限由 `fetch.maxRedirects` 控制；
- 抓取只处理文本类响应（html / text / json / xml）：PDF、图片等二进制仍会报 `WEB_UNSUPPORTED_CONTENT_TYPE`，与内置一致；
- 回退有代价：主模型不检索时，一次搜索要多花一次请求（`deepseek-v4.1-flash` 实测 ~10s、约 4k 输出 token），所以「不检索」记忆默认开着；
- 记忆只在**本进程内**有效，重启 DSH 后第一次搜索仍会按原顺序试一遍；
- 「哪些模型会检索」随时可能随 Go 上游变化，README 里那张表只是 2026-10-20 的快照，以实际请求为准。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-opencode-go
```

卸载（或关掉整个插件）后 `globalThis.fetch` 由 effect disposer 还原，插件注册的搜索与抓取提供方也会被摘掉，`web` 回到 base 的 `deepseek-official` 与 `http`。

## 开发与测试

```bash
node test/mechanism.test.mjs   # 94 项断言，无需安装任何依赖
node test/fetch.test.mjs       # 83 项断言，起本地 HTTP 服务跑真实请求
node tools/compat-check.mjs    # 升级 DSH 后核对宿主契约（见「兼容性」）
```

用轻量 ctx 桩 + fetch 桩驱动，覆盖：聊天链路会话头注入、辅助请求的环境变量回退、非 Go 主机透传、路由级模板覆盖、搜索请求形状（端点/凭据/会话头/工具定义）、响应映射（snippet、publishedAt、去重、truncated）、`search.model` 写死与 `'auto'` 跟随与 `'auto'` 无聊天模型兜底、回退链（静默不检索 / HTTP 400 / 403 RegionError 各一条）、401 与普通 403 不重试、开关 1（`modelFallback: false` 只试主模型）、开关 2（`officialFallback` 打开时走官方端点/模型/`DEEPSEEK_API_KEY`，默认不打官方）、「学到不检索即跳过」缓存与 `noSearchCacheMinutes: 0` 关闭、旧字段 `fallbackModel` 别名、工具错误项与 `max_tokens` 提示、无会话来源时的进程级兜底、`ctx.inject` 延迟注册、HMR 重复注册降级、配置不再指向本插件时 `available()` 自动让路、bundle 里保留 `- id: web` 指向（关闭即回原始配置）、卸载时摘掉自己的注册、错误码（`WEB_ABORTED` / `WEB_PROVIDER_ERROR` / `WEB_PROVIDER_CREDENTIAL_MISSING`）、dispose 还原 fetch。

抓取那套另测：html / text / json 分类与 charset 解码、二进制与非 2xx、Content-Length 预检、字节与字符截断、逐跳重定向（相对 Location / 跨域 / 超限 / 302 到内网字面量）、超时与取消、IP 字面量判定表、非公网段拦截、`allowIpLiterals` 开关、`available()` 跟随 `web.fetchProvider`、HMR 重复注册替换、bundle patch 与提供方 id 的一致性。

## 工作原理补充：一次搜索的模型选择

```
search.model ──'auto'──> 最近一次聊天模型（没见过则用默认模型）
      │
      ├─ 本次响应有 web_search_result ──> 返回 sources
      ├─ 响应没有 web_search_tool_result ──> 记该模型 30 分钟「不检索」，换下一个
      ├─ HTTP 400 ModelProtocolUnsupported ──> 换下一个
      ├─ HTTP 403 RegionError ──> 换下一个（地区限制）
      ├─ HTTP 429/5xx/网络错误 ──> 换下一个
      ├─ HTTP 401 ──> 立即失败（凭据问题，换模型无用）
      └─ HTTP 403 其它类型 ──> 立即失败（权限问题）
```

候选顺序 = 主模型 + `fallbackModels`，去重；已被记住「不检索」的模型会被直接跳过，若全都记得则仍按原顺序全试（不让缓存挡住唯一可能可用的模型）。

## License

MIT
