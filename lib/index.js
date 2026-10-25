// dsh-plugin-opencode-go — OpenCode Go 套餐适配插件（宿主侧）。
//
// 插件负责四件事：
//
// 1) 会话头。OpenCode Go 要求客户端「为每个会话发送稳定的会话标识」
//    （https://opencode.ai/docs/go → "Where can I use it"），并点名 DSH 的会话信息
//    只在部分模型路径上送达。DSH 的**聊天**请求可以经 `llm/stream` 瀑布按会话注入，
//    但**辅助请求**（web_search 的 Messages 调用、模型发现等）走各自 provider 的
//    fetch，不经过瀑布。本插件在进程级包装 globalThis.fetch，把会话头统一补到发往
//    Go 网关的每一条请求上，两条链路一起覆盖。
//
// 2) 模型。注册一个直连 Go 网关的 web_search 提供方，模型由本插件配置决定：
//    写死一个模型 id，或写 'auto' 跟随当前聊天模型。切换模型只需要改一处
//    （`config.search.model`），或干脆在 DSH 界面里换聊天模型、搜索自动跟随。
//    Go 上并非每个模型都真的执行 Anthropic 的服务端 web_search：有的把工具吞掉
//    只回一段文字，有的甚至不认 Messages 协议（HTTP 400）。所以主模型没检索成时，
//    按 `config.search.fallbackModels` 依次回退，并把「不检索」的模型记一小段时间，
//    避免每次搜索都先白跑一轮。
//
// 3) 抓取。DSH 内置的 web-fetch-http 在连接前自己解析域名，并要求整组 A/AAAA
//    答案都是公网 unicast。代理软件的 fake-ip 会把域名解析到 198.18.0.0/15 或
//    fc00::/7，于是 web_fetch 直接报「resolves to a non-public IP address」，
//    而浏览器/普通 fetch 明明能打开（假 IP 被路由器透明转发）。本插件因此注册
//    一个不做该解析校验的抓取提供方（见 lib/fetch.js），只保留协议、URL 凭据、
//    非公网 IP 字面量三道本地检查，以及字节/字符/重定向/超时上限。
//
// 4) 多 key。配置 `keys` 后，按 priority 选 key、按会话粘滞；同一对话固定一个 key，
//    连续失败（默认 2 次）或 401/402/403 才换下一个，同优先级随机。聊天与搜索
//    共用同一个 key 池，key 值通过覆盖请求的 Authorization 生效（见 lib/keys.js）。
//
// 无运行时依赖：只用 node:async_hooks / node:fs / node:net / node:os / node:path。
// 唯一可选的宿主依赖是 `@deepseek-ai/schemastery`：用来声明 `Config`，好让 DSH 的
// 插件页生成「配置」表单（字段标 `.volatile()` 才会出现）。装不到就退化为纯文件配置，
// 插件照常工作。

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  FETCH_DEFAULTS,
  FETCH_PROVIDER_ID,
  attachFetchProvider,
  createFetchProvider,
  normalizeFetchConfig,
} from './fetch.js'
import { createKeyPool, normalizeKeys } from './keys.js'

export const name = 'opencode-go'

/** 进程内唯一标记，防止同一进程重复包装 fetch。 */
const FETCH_MARK = Symbol.for('dsh-plugin-opencode-go.fetch')

/** 承载当前 llm/stream 请求上下文的存储：fetch 包装据此取会话 id / 路由 / 模型。 */
const als = new AsyncLocalStorage()

/** 请求 UA：Go 要求客户端表明自己的身份，而不是通用 SDK 名。 */
const USER_AGENT = 'dsh-plugin-opencode-go/0.3.0'

const DEFAULT_CHAT_PROVIDERS = ['opencode-go']

const DEFAULTS = {
  hosts: ['opencode.ai'],
  headers: {
    'x-opencode-session': '{sessionId}',
    'x-deepseek-harness-session-id': '{sessionId}',
  },
  onlyIfMissing: false,
  patchFetch: true,
  chatProviders: DEFAULT_CHAT_PROVIDERS,
  // 多 key：按 priority 从高到低用；空数组 = 保持旧的单 key 行为。
  keys: [],
  // 408/429/5xx/网络错误连续失败几次后换 key；401/403 立即换。
  keyFailoverAfter: 2,
  search: {
    provider: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    // 默认模型：实测会检索、单价低（$0.10/$0.50 每 1M token ≈ $0.002/次）、且自带
    // citation 摘要（snippet）的那个；额度约 7,400 次/月（见 README「成本」）。
    model: 'claude-haiku-5-5',
    // 主模型没返回检索结果时按顺序重试：先免费档，最后贵但稳的。
    fallbackModels: ['minimax-m3.1-flash-free', 'deepseek-v4-pro'],
    // 开关 1：是否在 Go 内部换模型重试（false = 只试 model 一个，失败即报错）。
    modelFallback: true,
    // 开关 2：Go 全部失败后，是否用官方 DeepSeek Messages 再兜底一次
    // （回到 DSH 原始搜索模型；按官方 API 计费，默认关）。
    officialFallback: false,
    officialBaseURL: 'https://api.deepseek.com/anthropic/v1',
    officialApiKeyEnv: 'DEEPSEEK_API_KEY',
    officialModel: 'deepseek-v4-flash',
    officialMaxTokens: 4096,
    officialMaxUses: 5,
    anthropicVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    // 记住「哪个模型不检索」的时长（分钟）；0 = 不记，每次搜索都按原顺序试。
    noSearchCacheMinutes: 30,
  },
  // 抓取上限与开关（见 lib/fetch.js）；provider 必须与 web.fetchProvider 一致。
  fetch: FETCH_DEFAULTS,
}

/** 未取到任何会话 id 时的兜底：进程级稳定值（Go 只要求稳定，不要求格式）。 */
const FALLBACK_SESSION_ID = `dsh-opencode-go-${String(process.pid)}`

/**
 * 宿主 `Config`：DSH 的插件页据此生成「配置」表单——只有标了 `.volatile()` 的字段会
 * 出现在表单里，保存后写入 profile patch 并热应用（`dsh-settings` 的机制）。
 * 拿不到 `@deepseek-ai/schemastery` 时退化为 `undefined`（无表单），插件照常工作。
 */
export const Config = await loadConfigSchema()

/** 构造插件页表单 schema；任何一步失败都返回 undefined，绝不拖垮插件加载。 */
async function loadConfigSchema() {
  let z
  try {
    const module = await import('@deepseek-ai/schemastery')
    z = module.default ?? module
  } catch {
    return undefined
  }
  if (typeof z?.object !== 'function') return undefined
  // 未知字段放行：配置文件里可能带着 schema 没列出的键，不能因此拒绝加载。
  const loose = (schema) => (typeof schema.loose === 'function' ? schema.loose() : schema)
  try {
    return loose(
      z.object({
        hosts: z.array(z.string()),
        headers: z.dict(z.string()),
        routes: z.any(),
        chatProviders: z.array(z.string()),
        onlyIfMissing: z.boolean(),
        patchFetch: z.boolean(),
        debug: z.any(),
        keys: z.array(z.any()),
        keyFailoverAfter: z.number(),
        search: loose(
          z.object({
            provider: z.string(),
            baseURL: z.string(),
            apiKeyEnv: z.string(),
            // ── 表单里可在线改的字段 ──────────────────────────────────────
            model: z.string().volatile(),
            modelFallback: z.boolean().volatile(),
            fallbackModels: z.array(z.string()).volatile(),
            officialFallback: z.boolean().volatile(),
            officialBaseURL: z.string().volatile(),
            officialApiKeyEnv: z.string().volatile(),
            officialModel: z.string().volatile(),
            officialMaxTokens: z.number().volatile(),
            officialMaxUses: z.number().volatile(),
            noSearchCacheMinutes: z.number().volatile(),
            maxTokens: z.number().volatile(),
            maxUses: z.number().volatile(),
            // ── 只读/一般配置：仍然只在文件里改 ──────────────────────────
            fallbackModel: z.string(),
            anthropicVersion: z.string(),
          }),
        ),
        fetch: loose(
          z.object({
            provider: z.string(),
            maxResponseBytes: z.number(),
            maxBodyChars: z.number(),
            timeoutMs: z.number(),
            maxRedirects: z.number(),
            allowIpLiterals: z.boolean(),
            userAgent: z.string(),
          }),
        ),
      }),
    )
  } catch {
    return undefined
  }
}

/** 把 schemastery 的 volatile 访问器（带 `get()`）还原成普通值；普通对象深拷贝。 */
function unwrapConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') {
    try {
      return unwrapConfig(value.get())
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(unwrapConfig)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapConfig(child)]))
}

/** 回退链归一：显式 fallbackModels 数组优先，其次旧的单值 fallbackModel，最后用默认链。 */
function normalizeFallbackModels(search) {
  const raw = Array.isArray(search.fallbackModels)
    ? search.fallbackModels
    : typeof search.fallbackModel === 'string' && search.fallbackModel.length > 0
      ? [search.fallbackModel]
      : DEFAULTS.search.fallbackModels
  return raw.filter((model) => typeof model === 'string' && model.length > 0)
}

/** 深合并默认值与用户配置（仅两层，够用且不引入依赖）。 */
function normalizeConfig(config) {
  // Config 声明后，`.volatile()` 字段在运行时是访问器，先还原成普通值。
  const input = unwrapConfig(typeof config === 'object' && config !== null ? config : {})
  const searchInput = typeof input.search === 'object' && input.search !== null ? input.search : {}
  const search = { ...DEFAULTS.search, ...searchInput, fallbackModels: normalizeFallbackModels(searchInput) }
  const keys = normalizeKeys(input.keys)
  return {
    ...DEFAULTS,
    ...input,
    keys,
    keyFailoverAfter:
      Number.isInteger(input.keyFailoverAfter) && input.keyFailoverAfter > 0
        ? input.keyFailoverAfter
        : DEFAULTS.keyFailoverAfter,
    headers: { ...DEFAULTS.headers, ...(typeof input.headers === 'object' && input.headers !== null ? input.headers : {}) },
    hosts: Array.isArray(input.hosts) && input.hosts.length > 0 ? input.hosts : DEFAULTS.hosts,
    chatProviders: Array.isArray(input.chatProviders) && input.chatProviders.length > 0 ? input.chatProviders : DEFAULTS.chatProviders,
    routes: typeof input.routes === 'object' && input.routes !== null ? input.routes : {},
    search,
    fetch: normalizeFetchConfig(input.fetch),
  }
}

/** 渲染 {sessionId}/{provider}/{model} 占位符。 */
function render(template, vars) {
  return String(template)
    .replaceAll('{sessionId}', vars.sessionId === undefined ? '' : String(vars.sessionId))
    .replaceAll('{provider}', vars.provider === undefined ? '' : String(vars.provider))
    .replaceAll('{model}', vars.model === undefined ? '' : String(vars.model))
}

/** 主机匹配：精确同名或子域。无法解析的 URL 一律不匹配。 */
function hostMatches(url, hosts) {
  if (typeof url !== 'string' || url.length === 0) return false
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((host) => {
    const wanted = String(host).toLowerCase()
    return hostname === wanted || hostname.endsWith(`.${wanted}`)
  })
}

/** 请求是否落在 Go API 的 baseURL 路径前缀下（用于判断要不要注入多 key）。 */
function apiPathMatches(url, baseURL) {
  try {
    const target = new URL(url)
    const base = new URL(String(baseURL))
    if (target.hostname !== base.hostname) return false
    const basePath = base.pathname.replace(/\/+$/u, '')
    return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  } catch {
    return false
  }
}

/** 可选调试日志：config.debug 为 true（写 DSH home）或一个文件路径。 */
function makeDebug(config) {
  const target = config.debug
  if (target === undefined || target === null || target === false) return () => {}
  const file =
    target === true
      ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'opencode-go-plugin.log')
      : String(target)
  return (event) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
    } catch {
      /* 调试日志永不打断请求 */
    }
  }
}

/**
 * 解析当前会话 id，按可靠性依次回退：
 * llm/stream 注入的 store → agents 服务的当前发起者 → DSH_SESSION_ID → 进程级兜底。
 */
function resolveSession(ctx) {
  const store = als.getStore()
  if (store !== undefined && store.sessionId !== undefined && store.sessionId !== null && String(store.sessionId).length > 0) {
    return { sessionId: String(store.sessionId), source: 'llm/stream', provider: store.provider, model: store.model }
  }
  try {
    const id = ctx.get?.('agents')?.currentInitiator?.()?.session?.id
    if (id !== undefined && id !== null && String(id).length > 0) return { sessionId: String(id), source: 'agents' }
  } catch {
    /* 服务不存在或调用失败都走下一个回退 */
  }
  const ambient = process.env.DSH_SESSION_ID
  if (typeof ambient === 'string' && ambient.length > 0) return { sessionId: ambient, source: 'env' }
  return { sessionId: FALLBACK_SESSION_ID, source: 'fallback' }
}

/** 选中一条请求该用的头模板：命中路由用路由表，否则用默认表。 */
function headersFor(config, provider) {
  const routeSpec = provider !== undefined ? config.routes[provider] : undefined
  return typeof routeSpec === 'object' && routeSpec !== null ? routeSpec : config.headers
}

/** 把 async iterable 的每一步都跑在 ALS store 里（惰性迭代器只包外层无效）。 */
function wrapIterable(inner, store) {
  if (inner == null || typeof inner[Symbol.asyncIterator] !== 'function') return inner
  const iterator = inner[Symbol.asyncIterator]()
  const run = (fn) => als.run(store, fn)
  return {
    next: (value) => run(() => iterator.next(value)),
    return: (value) => run(() => (iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value }))),
    throw: (error) => run(() => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/** 递归包装瀑布结果，使异步迭代器的每一步都带 store。 */
function wrapResult(result, store) {
  if (result == null) return result
  if (typeof result[Symbol.asyncIterator] === 'function') return wrapIterable(result, store)
  if (typeof result.then === 'function') return result.then((value) => wrapResult(value, store))
  return result
}

/**
 * 包装 globalThis.fetch：
 * - 命中 Go 主机时补会话头（聊天 + 辅助请求两条链路）；
 * - 配置了 keys 时按会话选择 key，并覆盖请求原有的 Authorization。
 */
function installFetchPatch(ctx, config, state, debug) {
  if (config.patchFetch === false) return
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    ctx.logger?.warn('opencode-go: globalThis.fetch 不可用，跳过请求头包装')
    return
  }
  if (original[FETCH_MARK] === true) {
    ctx.logger?.warn('opencode-go: fetch 已被本插件包装过，跳过重复包装')
    return
  }

  const patched = async function fetch(input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (!hostMatches(url, config.hosts)) return original.call(this, input, init)

    let session
    let headers
    const applied = {}
    try {
      session = resolveSession(ctx)
      const spec = headersFor(config, session.provider)
      headers = new Headers(
        init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      for (const [key, value] of Object.entries(spec ?? {})) {
        if (typeof value !== 'string') continue
        if (config.onlyIfMissing === true && headers.has(key)) continue
        const rendered = render(value, session)
        headers.set(key, rendered)
        applied[key] = rendered
      }
    } catch (error) {
      debug({ event: 'request-error', url, error: String(error) })
      return original.call(this, input, init)
    }

    let selectedKey
    const authenticated = headers.has('authorization') || headers.has('x-api-key') || apiPathMatches(url, config.search.baseURL)
    if (state.keyPool?.enabled === true && authenticated) {
      try {
        selectedKey = await state.keyPool.pick(session.sessionId)
        if (selectedKey !== undefined) {
          try {
            headers.set('authorization', `Bearer ${selectedKey.value}`)
            if (headers.has('x-api-key')) headers.set('x-api-key', selectedKey.value)
          } catch (error) {
            // 凭据里混入了 HTTP 头装不下的字符：跳过覆盖，交给原来的认证。
            selectedKey = undefined
            debug({ event: 'key-invalid', url, sessionId: session.sessionId, error: String(error) })
          }
        }
      } catch (error) {
        debug({ event: 'key-error', url, sessionId: session.sessionId, error: String(error) })
      }
    }

    debug({
      event: 'request',
      url,
      sessionId: session.sessionId,
      sessionSource: session.source,
      headers: applied,
      ...(selectedKey !== undefined ? { keyRef: selectedKey.ref, keyPriority: selectedKey.priority } : {}),
    })

    let response
    try {
      response = await original.call(this, input, { ...init, headers })
    } catch (error) {
      // 主动取消不算 key 失败；其它网络错误计入连续失败。
      if (selectedKey !== undefined && error?.name !== 'AbortError') {
        state.keyPool?.record(session.sessionId, { ref: selectedKey.ref, networkError: true })
      }
      throw error
    }
    if (selectedKey !== undefined) {
      const outcome = state.keyPool?.record(session.sessionId, { ref: selectedKey.ref, status: response.status })
      if (outcome?.rotated === true) {
        debug({ event: 'key-rotate', sessionId: session.sessionId, from: outcome.ref })
      }
    }
    return response
  }
  patched[FETCH_MARK] = true

  ctx.effect(() => {
    globalThis.fetch = patched
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = original
    }
  }, 'opencode-go: wrap fetch')
}

/** 从凭据服务或启动环境解析 apiKeyEnv 指向的密钥。 */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(ref)
    const value = resolved?.value
    if (typeof value === 'string' && value.length > 0) return value
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

/**
 * 本次搜索要依次尝试的模型：配置值（'auto' 时跟随最近一次聊天模型）打头，
 * 后面接 fallbackModels；去重并保持顺序。`modelFallback: false` 时只留主模型。
 */
function resolveSearchModels(search, state) {
  const ordered = []
  const push = (model) => {
    if (typeof model === 'string' && model.length > 0 && !ordered.includes(model)) ordered.push(model)
  }
  if (search.model === 'auto') push(state.lastChatModel)
  else push(search.model)
  // 'auto' 但还没见过聊天模型：直接用默认模型起头，别把搜索卡住。
  if (ordered.length === 0) push(DEFAULTS.search.model)
  if (search.modelFallback !== false) {
    for (const model of search.fallbackModels ?? []) push(model)
  }
  return ordered
}

/** 该模型是否还在「已知不检索」的记忆窗口内。 */
function isNoSearchCached(state, search, model) {
  const minutes = Number(search.noSearchCacheMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  const until = state.noSearchUntil.get(model)
  return until !== undefined && until > Date.now()
}

/** 记住某个模型不执行服务端检索；返回是否首次记录（用于只告警一次）。 */
function rememberNoSearch(state, search, model) {
  const minutes = Number(search.noSearchCacheMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  const first = !state.noSearchUntil.has(model)
  state.noSearchUntil.set(model, Date.now() + minutes * 60_000)
  return first
}

/**
 * 过滤掉记忆窗口内的「不检索」模型；若全被过滤（说明缓存过旧或只剩它们），
 * 仍然按原顺序全试一遍，不让缓存把唯一可能可用的模型也挡掉。
 */
function pickAttempts(candidates, search, state) {
  const fresh = candidates.filter((model) => !isNoSearchCached(state, search, model))
  return fresh.length > 0 ? fresh : candidates
}

/** web_search_tool_result 的 content 可能是结果数组，也可能是一个错误对象。 */
function resultItems(block) {
  const content = block?.content
  if (Array.isArray(content)) return content
  return content === null || content === undefined ? [] : [content]
}

/** 拆出响应里的全部块，以及 web_search_tool_result 里的所有内容项。 */
function inspectResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  return { blocks, resultBlocks, items: resultBlocks.flatMap((block) => resultItems(block)) }
}

/** 一句话概括响应形态（stop_reason + 块类型），用于报错与日志。 */
function describeResponse(response) {
  const { blocks } = inspectResponse(response)
  const types = blocks.map((block) => block?.type ?? 'unknown')
  const stop = typeof response?.stop_reason === 'string' && response.stop_reason.length > 0 ? response.stop_reason : 'unknown'
  return `stop_reason=${stop}，块类型=[${types.join(', ') || '空'}]`
}

/**
 * 把 Anthropic Messages 响应映射为 seam 的搜索结果。
 * 与 @deepseek-ai/dsh-web-search-deepseek（MIT）的映射一致：sources 取自
 * web_search_tool_result 里的 web_search_result 项，snippet 取自文本块
 * citations[] 中同 URL 的 cited_text，按 URL 去重。
 *
 * 没有检索结果时抛出 `error.code` 为 'no-search'（模型没执行工具）或
 * 'search-error'（工具执行了但上游报错）的错误，由调用方决定是否回退模型。
 */
function mapSearchSources(response, model = 'unknown') {
  const { blocks, items } = inspectResponse(response)
  const results = items.filter((item) => item?.type === 'web_search_result')

  if (results.length === 0) {
    const failure = items.find((item) => item?.type === 'web_search_tool_result_error')
    if (failure !== undefined) {
      const error = new Error(
        `检索工具返回错误（model=${model}，error_code=${String(failure.error_code ?? 'unknown')}）：${describeResponse(response)}`,
      )
      error.code = 'search-error'
      throw error
    }
    const hint = response?.stop_reason === 'max_tokens' ? '；max_tokens 可能被思考内容吃光，可调大 search.maxTokens' : ''
    const error = new Error(
      `响应里没有 web_search_tool_result 块（${describeResponse(response)}），说明该模型没有执行服务端 web_search${hint}`,
    )
    error.code = 'no-search'
    throw error
  }

  const snippets = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (typeof cite?.url === 'string' && cite.url.length > 0 && typeof cite.cited_text === 'string' && cite.cited_text.length > 0 && !snippets.has(cite.url)) {
        snippets.set(cite.url, cite.cited_text)
      }
    }
  }

  const seen = new Set()
  const sources = []
  for (const item of results) {
    if (typeof item.url !== 'string' || item.url.length === 0 || seen.has(item.url)) continue
    seen.add(item.url)
    sources.push({
      url: item.url,
      ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
      ...(snippets.has(item.url) ? { snippet: snippets.get(item.url) } : {}),
      ...(typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
    })
  }
  return { sources, truncated: false }
}

/** 从错误响应体里挖出上游的类型与细节文案（兼容 string 与 {type,message} 两种 error 形状）。 */
async function readErrorBody(response) {
  try {
    const parsed = await response.json()
    const error = parsed?.error
    const message = typeof error === 'string' ? error : (error?.message ?? parsed?.message)
    const type = typeof error === 'object' && error !== null ? (error.type ?? error.code) : undefined
    return {
      message: typeof message === 'string' && message.length > 0 ? message : undefined,
      type: typeof type === 'string' && type.length > 0 ? type : undefined,
    }
  } catch {
    return {}
  }
}

/** 取消/超时错误：seam 与超时策略都按 `WEB_ABORTED` 路由。 */
function abortedError() {
  return withWebCode(new Error('OpenCode Go 搜索已取消'), 'WEB_ABORTED')
}

/** 给错误补上 web seam 的错误码（`@deepseek-ai/dsh-web` 的词汇，钩子/UI 会按 code 路由）。 */
function withWebCode(error, code) {
  if (error !== null && typeof error === 'object' && (typeof error.code !== 'string' || error.code.length === 0)) {
    error.code = code
  }
  return error
}

/** 候选模型全挂时的报错：把每个模型的失败原因摊开，顺手给出改法。 */
function searchFailureError(problems) {
  const fix =
    '修法：把插件配置里的 search.model 换成实测支持服务端 web_search 的模型（claude-haiku-5-5、deepseek-v4-pro、kimi-k3），' +
    '或调整 search.fallbackModels 回退链。'
  const error =
    problems.length === 1
      ? new Error(`OpenCode Go 搜索失败（model "${problems[0].model}"）：${problems[0].reason}\n${fix}`)
      : new Error(
          `OpenCode Go 搜索失败：候选模型都没有返回检索结果（已尝试 ${problems.length} 个）。\n` +
            problems.map((problem) => `  - "${problem.model}"：${problem.reason}`).join('\n') +
            `\n${fix}`,
        )
  error.causes = problems
  // 失败原因都指向「凭据」时保留更精确的 seam 错误码，其余统一为 WEB_PROVIDER_ERROR。
  const explicit = problems.map((problem) => problem.code).filter((code) => typeof code === 'string' && code.length > 0)
  const allCredential = explicit.length > 0 && explicit.every((code) => code === 'WEB_PROVIDER_CREDENTIAL_MISSING')
  return withWebCode(error, allCredential ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR')
}

/**
 * 把提供方挂到 web seam，并处理重复注册。
 *
 * DSH 0.2 的 `WebRuntime.registerProvider` 用 `this.ctx.effect` 记账（见 dsh-web 源码），
 * 也就是注册跟着 **web 服务**的 fiber 走，而不是本插件的 fiber：本插件热重载/被禁用时
 * 旧注册不会被释放，再次 apply 会抛 `WEB_DUPLICATE_PROVIDER`。这里先摘掉同 id 的旧条目
 * 再挂新的，让新配置立刻生效；摘不掉就告警保留旧实现（重启后生效）。
 *
 * 返回值是「注销本次注册」的函数（`null` 表示没挂上），供插件卸载时清理，
 * 避免卸载后 seam 里还留着一个指向本插件的旧提供方。
 */
function attachSearchProvider(ctx, scope, provider) {
  const disposer = (value) => (typeof value === 'function' ? value : () => {})
  try {
    return disposer(scope.web.registerSearchProvider(provider))
  } catch (error) {
    if (error?.code !== 'WEB_DUPLICATE_PROVIDER') {
      ctx.logger?.warn(`opencode-go: 注册搜索提供方失败：${String(error?.message ?? error)}`)
      return null
    }
    const registry = scope.web.searchProviders
    if (!(registry instanceof Map) || !registry.delete(provider.id)) {
      ctx.logger?.warn(
        `opencode-go: 搜索提供方 "${String(provider.id)}" 已被占用且无法替换，保留旧实现；重启 DSH 后新配置生效`,
      )
      return null
    }
    try {
      const replaced = disposer(scope.web.registerSearchProvider(provider))
      ctx.logger?.warn(`opencode-go: 搜索提供方 "${String(provider.id)}" 已存在，已用本次配置替换旧注册`)
      return replaced
    } catch (second) {
      ctx.logger?.warn(`opencode-go: 替换搜索提供方失败：${String(second?.message ?? second)}`)
      return null
    }
  }
}

/**
 * 官方兜底的鉴权：优先用账号登录态（与内置 web-search-deepseek 一致，发 `x-dsh-auth-token`），
 * 没有再退回 `officialApiKeyEnv` 指向的 API key。
 */
async function officialAuth(ctx, search, endpoint) {
  try {
    const account = ctx.get?.('deepseekAccount')
    if (account !== undefined && typeof account.resolveToken === 'function') {
      const token = await account.resolveToken(endpoint)
      if (typeof token === 'string' && token.length > 0) {
        return { kind: 'account', headers: { 'x-dsh-auth-token': token } }
      }
    }
  } catch {
    /* 账号登录态不可用就退回 API key */
  }
  const apiKey = await resolveApiKey(ctx, String(search.officialApiKeyEnv))
  if (apiKey === undefined) {
    throw withWebCode(
      new Error(
        `官方兜底缺少凭据：既没有账号登录态，也没有 "${String(search.officialApiKeyEnv)}"；` +
          '要么在 DSH 里登录 DeepSeek 账号，要么在 ~/.dsh/.credentials.yaml 里配置该引用',
      ),
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  return { kind: 'api-key', headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` } }
}

/**
 * 用官方 DeepSeek Messages 端点兜底检索——回到 DSH 原始搜索模型。
 * 只有 `search.officialFallback: true` 时才会走到这里，按官方 API 计费。
 */
async function officialSearch(ctx, search, query, signal, debug) {
  const endpoint = `${String(search.officialBaseURL).replace(/\/+$/u, '')}/messages`
  const { kind: authKind, headers: authHeaders } = await officialAuth(ctx, search, endpoint)
  const model = String(search.officialModel)
  const body = {
    model,
    max_tokens: Number(search.officialMaxTokens),
    messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Number(search.officialMaxUses) }],
  }
  debug({ event: 'search-official', endpoint, model, auth: authKind })

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...authHeaders,
        'anthropic-version': String(search.anthropicVersion),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted === true) throw abortedError()
    throw withWebCode(new Error(`官方兜底请求失败：${String(error)}`), 'WEB_PROVIDER_ERROR')
  }
  if (!response.ok) {
    const { message: detail } = await readErrorBody(response)
    throw withWebCode(
      new Error(`官方兜底失败（HTTP ${response.status}）${detail === undefined ? '' : `：${detail}`}`),
      'WEB_PROVIDER_ERROR',
    )
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw withWebCode(new Error(`官方兜底响应不是 JSON：${String(error)}`), 'WEB_PROVIDER_ERROR')
  }
  return mapSearchSources(payload, `official:${model}`)
}

/** 注册直连 Go 网关的 web_search 提供方。 */
function registerSearchProvider(ctx, config, state, debug) {
  const search = config.search
  const baseURL = String(search.baseURL).replace(/\/+$/u, '')
  const endpoint = `${baseURL}/messages`

  /** 挂载时的 web seam（attach 里赋值），供 available() 读取当前选择。 */
  let webScope

  /**
   * 读 web seam 当前配置的搜索提供方 id（0.2.1 是 config accessor，0.2.0 是字段）。
   * 读不到就返回 undefined，不猜。
   */
  const configuredProviderId = () => {
    try {
      const accessor = webScope?.web?.config?.searchProvider
      if (typeof accessor === 'string') return accessor
      if (accessor !== undefined && accessor !== null && typeof accessor.get === 'function') return accessor.get()
      return webScope?.web?.searchProviderId
    } catch {
      return undefined
    }
  }

  const provider = {
    id: String(search.provider),
    // 只在自己被显式指到（或读不到选择）时可用：万一配置不再指向本插件，
    // 自动让路给内置提供方，避免两个可用提供方触发 WEB_PROVIDER_AMBIGUOUS。
    available: () => {
      const configured = configuredProviderId()
      return configured === undefined || configured === search.provider
    },
    async search(request, signal) {
      const session = resolveSession(ctx)
      let legacyApiKey
      if (state.keyPool?.enabled !== true) {
        legacyApiKey = await resolveApiKey(ctx, String(search.apiKeyEnv))
      }
      let selectedKey
      if (state.keyPool?.enabled === true) {
        selectedKey = await state.keyPool.pick(session.sessionId)
      }
      // 多 key 都解析不到时，退回旧的单 key 配置。
      if (selectedKey === undefined && legacyApiKey === undefined) {
        legacyApiKey = await resolveApiKey(ctx, String(search.apiKeyEnv))
      }
      const apiKey = selectedKey?.value ?? legacyApiKey
      const missingGoCredential = apiKey === undefined
      // 没有 Go 凭据时：开了官方兜底就跳过 Go 直接兜底，否则按缺凭据报错。
      if (missingGoCredential && search.officialFallback !== true) {
        const hint =
          state.keyPool?.enabled === true
            ? `keys 里的引用（${state.keyPool.entries.map((entry) => entry.ref).join('、')}）或 apiKeyEnv "${String(search.apiKeyEnv)}"`
            : `"${String(search.apiKeyEnv)}"`
        throw withWebCode(
          new Error(
            `OpenCode Go 搜索没有可用的凭据：请配置 ${hint}，` +
              '在 ~/.dsh/.credentials.yaml 里写入该引用，或在启动环境里导出它。',
          ),
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      const baseHeaders = {
        'anthropic-version': String(search.anthropicVersion),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      }
      const attempts = missingGoCredential ? [] : pickAttempts(resolveSearchModels(search, state), search, state)
      const problems = []
      if (missingGoCredential) {
        problems.push({
          model: String(search.model),
          reason: `缺少 Go 凭据 "${String(search.apiKeyEnv)}"，已跳过 Go 模型`,
          code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        })
      }

      for (const [index, model] of attempts.entries()) {
        if (signal?.aborted === true) throw abortedError()
        // 每次尝试都重新取 key：上一次失败可能已经把当前 key 轮换掉了。
        if (state.keyPool?.enabled === true) {
          const nextKey = await state.keyPool.pick(session.sessionId)
          if (nextKey !== undefined) selectedKey = nextKey
        }
        const attemptKey = selectedKey?.value ?? legacyApiKey
        const headers = {
          ...baseHeaders,
          'x-api-key': attemptKey ?? '',
          authorization: `Bearer ${attemptKey ?? ''}`,
        }
        for (const [key, value] of Object.entries(headersFor(config, session.provider) ?? {})) {
          if (typeof value === 'string') headers[key] = render(value, { ...session, model })
        }
        const body = {
          model,
          max_tokens: Number(search.maxTokens),
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
            },
          ],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Number(search.maxUses) }],
        }
        debug({
          event: 'search',
          endpoint,
          model,
          attempt: index,
          sessionId: session.sessionId,
          sessionSource: session.source,
          ...(selectedKey !== undefined ? { keyRef: selectedKey.ref, keyPriority: selectedKey.priority } : {}),
        })

        let response
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers,
            body: JSON.stringify(body),
            ...(signal !== undefined ? { signal } : {}),
          })
        } catch (error) {
          if (signal?.aborted === true) throw abortedError()
          if (config.patchFetch === false && selectedKey !== undefined) {
            state.keyPool?.record(session.sessionId, { ref: selectedKey.ref, networkError: true })
          }
          problems.push({ model, reason: `请求失败：${String(error)}` })
          continue
        }

        // patchFetch: false 时没有 fetch 包装记录结果，这里补上，保证 key 仍能轮换。
        if (config.patchFetch === false && selectedKey !== undefined) {
          const outcome = state.keyPool?.record(session.sessionId, { ref: selectedKey.ref, status: response.status })
          if (outcome?.rotated === true) debug({ event: 'key-rotate', sessionId: session.sessionId, from: outcome.ref })
        }

        if (!response.ok) {
          const { message: detail, type: errorType } = await readErrorBody(response)
          problems.push({
            model,
            reason: `请求失败（HTTP ${response.status}）${detail === undefined ? '' : `：${detail}`}`,
            ...(response.status === 401 ? { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' } : {}),
          })
          // 401 一定是凭据问题；403 只有在区域限制时值得换模型，其它 403 视为权限问题。
          // 开了多 key 时这些状态已经触发了 key 轮换，继续试下一个模型（用新 key）。
          if (response.status === 401 || (response.status === 403 && errorType !== 'RegionError')) {
            if (state.keyPool?.enabled !== true) break
            continue
          }
          continue
        }

        let payload
        try {
          payload = await response.json()
        } catch (error) {
          problems.push({ model, reason: `响应不是 JSON：${String(error)}` })
          continue
        }

        try {
          const { sources } = mapSearchSources(payload, model)
          if (index > 0) ctx.logger?.warn?.(`opencode-go: 主搜索模型没有返回检索结果，已回退到 "${model}" 完成本次搜索`)
          return { sources, truncated: false }
        } catch (error) {
          problems.push({ model, reason: error instanceof Error ? error.message : String(error) })
          debug({ event: 'search-no-result', model, code: error?.code, message: String(error?.message ?? error) })
          // rememberNoSearch 在缓存关闭（noSearchCacheMinutes <= 0）时返回 false，不告警。
          if (error?.code === 'no-search' && rememberNoSearch(state, search, model)) {
            ctx.logger?.warn?.(
              `opencode-go: 模型 "${model}" 不执行服务端 web_search，${String(search.noSearchCacheMinutes)} 分钟内优先跳过它`,
            )
          }
        }
      }

      // 开关 2：Go 全部失败后，用官方 DeepSeek 再兜底一次（等于回到 DSH 原始搜索模型）。
      if (search.officialFallback === true) {
        if (signal?.aborted === true) throw abortedError()
        try {
          const { sources } = await officialSearch(ctx, search, request.query, signal, debug)
          ctx.logger?.warn?.('opencode-go: Go 模型都没搜到结果，已由官方 DeepSeek 兜底完成本次搜索')
          return { sources, truncated: false }
        } catch (error) {
          problems.push({
            model: `official:${String(search.officialModel)}`,
            reason: error instanceof Error ? error.message : String(error),
            ...(typeof error?.code === 'string' && error.code.length > 0 ? { code: error.code } : {}),
          })
          debug({ event: 'search-official-failed', message: String(error?.message ?? error) })
        }
      }

      if (problems.length === 0) {
        throw withWebCode(new Error('OpenCode Go 搜索失败：search.model 与 search.fallbackModels 里没有任何可尝试的模型'), 'WEB_PROVIDER_ERROR')
      }
      throw searchFailureError(problems)
    },
  }

  const attach = (scope) => {
    if (scope?.web === undefined || typeof scope.web.registerSearchProvider !== 'function') {
      ctx.logger?.warn('opencode-go: web seam 不可用，跳过搜索提供方注册')
      return
    }
    webScope = scope
    // 注册提供方；注销函数挂在插件自己的 effect 上，卸载时把 seam 里的旧条目摘掉。
    const dispose = attachSearchProvider(ctx, scope, provider)
    if (dispose === null) return
    ctx.effect(
      () => () => {
        try {
          dispose()
        } catch {
          /* 卸载时尽力而为 */
        }
      },
      'opencode-go: release search provider',
    )
    ctx.logger?.info?.('opencode-go: 已注册搜索提供方 "%s" → %s', String(search.provider), endpoint)
  }

  // web 服务可能比本插件晚挂载：用 ctx.inject 等它就绪（等价于内置插件的 inject: ['web']），
  // 否则注册会被静默跳过，搜索端只会看到「configured web provider is not registered」。
  if (typeof ctx.inject === 'function') ctx.inject(['web'], attach)
  else attach(ctx)
}

/**
 * 注册不做「公网解析」校验的抓取提供方（fake-ip / 透明代理环境用，见 lib/fetch.js）。
 *
 * 与搜索提供方同一套节奏：等 web 服务就绪再注册；配置不再指向本插件时
 * `available()` 返回 false 自动让路，避免两个可用提供方触发 WEB_PROVIDER_AMBIGUOUS。
 */
function registerFetchProvider(ctx, config, debug) {
  const provider = createFetchProvider(config.fetch, debug)

  const attach = (scope) => {
    if (scope?.web === undefined || typeof scope.web.registerFetchProvider !== 'function') {
      ctx.logger?.warn('opencode-go: web seam 不支持抓取提供方注册，跳过')
      return
    }
    const dispose = attachFetchProvider(ctx, scope, provider)
    if (dispose === null) return
    ctx.effect(
      () => () => {
        try {
          dispose()
        } catch {
          /* 卸载时尽力而为 */
        }
      },
      'opencode-go: release fetch provider',
    )
    ctx.logger?.info?.('opencode-go: 已注册抓取提供方 "%s"', String(provider.id))
  }

  if (typeof ctx.inject === 'function') ctx.inject(['web'], attach)
  else attach(ctx)
}

export function apply(ctx, config = {}) {
  const merged = normalizeConfig(config)
  const debug = makeDebug(merged)
  const keyPool = createKeyPool({
    keys: merged.keys,
    failoverAfter: merged.keyFailoverAfter,
    // 单个凭据解析失败只跳过这个 ref，不拖垮请求。
    resolve: (ref) => resolveApiKey(ctx, ref).catch(() => undefined),
    logger: ctx.logger,
  })
  const state = { lastChatModel: undefined, noSearchUntil: new Map(), keyPool }
  if (keyPool.enabled) {
    ctx.logger?.info?.(
      'opencode-go: 已启用多 key，共 %d 个；连续失败 %d 次后轮换',
      keyPool.entries.length,
      keyPool.failoverAfter,
    )
  }

  installFetchPatch(ctx, merged, state, debug)

  // llm/stream 瀑布：为聊天请求绑定会话上下文，并记录当前聊天模型供 search.model: 'auto' 使用。
  ctx.on('llm/stream', (options, next) => {
    const store = { provider: options?.provider, sessionId: options?.sessionId, model: options?.model }
    if (typeof store.model === 'string' && merged.chatProviders.includes(store.provider)) state.lastChatModel = store.model
    return wrapResult(als.run(store, next), store)
  })

  registerSearchProvider(ctx, merged, state, debug)
  registerFetchProvider(ctx, merged, debug)
}

export {
  FETCH_PROVIDER_ID,
  mapSearchSources,
  hostMatches,
  normalizeConfig,
  normalizeFallbackModels,
  normalizeFetchConfig,
  render,
}
