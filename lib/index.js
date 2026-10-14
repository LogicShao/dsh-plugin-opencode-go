// dsh-plugin-opencode-go — OpenCode Go 套餐适配插件（宿主侧）。
//
// 插件负责两件事：
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
//
// 无运行时依赖：只用 node:async_hooks / node:fs / node:os / node:path。
// 不 import 任何 @deepseek-ai/* 包；挂钩契约只有三处——`llm/stream` 事件名，
// 请求上的 options.provider/options.model/options.sessionId 字段，以及
// ctx.web.registerSearchProvider(provider) 这个 web seam 方法。

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'opencode-go'

/** 进程内唯一标记，防止同一进程重复包装 fetch。 */
const FETCH_MARK = Symbol.for('dsh-plugin-opencode-go.fetch')

/** 承载当前 llm/stream 请求上下文的存储：fetch 包装据此取会话 id / 路由 / 模型。 */
const als = new AsyncLocalStorage()

/** 请求 UA：Go 要求客户端表明自己的身份，而不是通用 SDK 名。 */
const USER_AGENT = 'dsh-plugin-opencode-go/0.1.0'

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
  search: {
    enabled: true,
    provider: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    model: 'deepseek-v4.1-flash',
    fallbackModel: 'deepseek-v4.1-flash',
    anthropicVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
  },
}

/** 未取到任何会话 id 时的兜底：进程级稳定值（Go 只要求稳定，不要求格式）。 */
const FALLBACK_SESSION_ID = `dsh-opencode-go-${String(process.pid)}`

/** 深合并默认值与用户配置（仅两层，够用且不引入依赖）。 */
function normalizeConfig(config) {
  const input = typeof config === 'object' && config !== null ? config : {}
  const search = { ...DEFAULTS.search, ...(typeof input.search === 'object' && input.search !== null ? input.search : {}) }
  return {
    ...DEFAULTS,
    ...input,
    headers: { ...DEFAULTS.headers, ...(typeof input.headers === 'object' && input.headers !== null ? input.headers : {}) },
    hosts: Array.isArray(input.hosts) && input.hosts.length > 0 ? input.hosts : DEFAULTS.hosts,
    chatProviders: Array.isArray(input.chatProviders) && input.chatProviders.length > 0 ? input.chatProviders : DEFAULTS.chatProviders,
    routes: typeof input.routes === 'object' && input.routes !== null ? input.routes : {},
    search,
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

/** 包装 globalThis.fetch：命中 Go 主机时补会话头（覆盖聊天与所有辅助请求两条链路）。 */
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

  const patched = function fetch(input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (!hostMatches(url, config.hosts)) return original.call(this, input, init)
    try {
      const session = resolveSession(ctx)
      const spec = headersFor(config, session.provider)
      const headers = new Headers(
        init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      const applied = {}
      for (const [key, value] of Object.entries(spec ?? {})) {
        if (typeof value !== 'string') continue
        if (config.onlyIfMissing === true && headers.has(key)) continue
        const rendered = render(value, session)
        headers.set(key, rendered)
        applied[key] = rendered
      }
      debug({ event: 'request', url, sessionId: session.sessionId, sessionSource: session.source, headers: applied })
      return original.call(this, input, { ...init, headers })
    } catch (error) {
      debug({ event: 'request-error', url, error: String(error) })
      return original.call(this, input, init)
    }
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

/** 决定本次搜索用哪个模型：'auto' 跟随最近一次聊天模型，否则用配置值。 */
function resolveSearchModel(search, state) {
  const configured = search.model
  if (configured === 'auto') {
    return state.lastChatModel ?? String(search.fallbackModel ?? DEFAULTS.search.model)
  }
  return String(configured ?? DEFAULTS.search.model)
}

/**
 * 把 Anthropic Messages 响应映射为 seam 的搜索结果。
 * 与 @deepseek-ai/dsh-web-search-deepseek（MIT）的映射一致：sources 取自
 * web_search_tool_result 里的 web_search_result 项，snippet 取自文本块
 * citations[] 中同 URL 的 cited_text，按 URL 去重。
 */
function mapSearchSources(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new Error(
      'OpenCode Go 没有返回 web_search_tool_result 块：当前模型可能不支持服务端 web_search 工具，' +
        '请把插件配置里的 search.model 换成一个支持检索的模型（例如 deepseek-v4.1-flash、claude-haiku-5-5）。',
    )
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
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result' || typeof item.url !== 'string' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({
        url: item.url,
        ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
        ...(snippets.has(item.url) ? { snippet: snippets.get(item.url) } : {}),
        ...(typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/** 注册直连 Go 网关的 web_search 提供方。 */
function registerSearchProvider(ctx, config, state, debug) {
  const search = config.search
  if (search.enabled === false) return
  const baseURL = String(search.baseURL).replace(/\/+$/u, '')
  const endpoint = `${baseURL}/messages`

  const provider = {
    id: String(search.provider),
    available: () => true,
    async search(request, signal) {
      const model = resolveSearchModel(search, state)
      const apiKey = await resolveApiKey(ctx, String(search.apiKeyEnv))
      if (apiKey === undefined) {
        throw new Error(
          `OpenCode Go 搜索没有可用的凭据 "${String(search.apiKeyEnv)}"：` +
            '请在 ~/.dsh/.credentials.yaml 里写入该引用，或在启动环境里导出它。',
        )
      }
      const session = resolveSession(ctx)
      const headers = {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': String(search.anthropicVersion),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
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
      debug({ event: 'search', endpoint, model, sessionId: session.sessionId, sessionSource: session.source })

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
        if (signal?.aborted === true) throw new Error('OpenCode Go 搜索已取消')
        throw new Error(`OpenCode Go 搜索请求失败：${String(error)}`)
      }
      if (!response.ok) {
        let detail
        try {
          const parsed = await response.json()
          detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
        } catch {
          /* 非 JSON 错误体：只报状态码 */
        }
        throw new Error(`OpenCode Go 搜索错误（HTTP ${response.status}）${typeof detail === 'string' && detail.length > 0 ? `：${detail}` : ''}`)
      }
      return mapSearchSources(await response.json())
    },
  }

  const attach = (scope) => {
    if (scope?.web === undefined || typeof scope.web.registerSearchProvider !== 'function') {
      ctx.logger?.warn('opencode-go: web seam 不可用，跳过搜索提供方注册')
      return
    }
    scope.web.registerSearchProvider(provider)
    ctx.logger?.info?.('opencode-go: 已注册搜索提供方 "%s" → %s', String(search.provider), endpoint)
  }

  // web 服务可能比本插件晚挂载：用 ctx.inject 等它就绪（等价于内置插件的 inject: ['web']），
  // 否则注册会被静默跳过，搜索端只会看到「configured web provider is not registered」。
  if (typeof ctx.inject === 'function') ctx.inject(['web'], attach)
  else attach(ctx)
}

export function apply(ctx, config = {}) {
  const merged = normalizeConfig(config)
  const debug = makeDebug(merged)
  const state = { lastChatModel: undefined }

  installFetchPatch(ctx, merged, state, debug)

  // llm/stream 瀑布：为聊天请求绑定会话上下文，并记录当前聊天模型供 search.model: 'auto' 使用。
  ctx.on('llm/stream', (options, next) => {
    const store = { provider: options?.provider, sessionId: options?.sessionId, model: options?.model }
    if (typeof store.model === 'string' && merged.chatProviders.includes(store.provider)) state.lastChatModel = store.model
    return wrapResult(als.run(store, next), store)
  })

  registerSearchProvider(ctx, merged, state, debug)
}

export { mapSearchSources, hostMatches, normalizeConfig, render }
