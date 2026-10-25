// Mechanism-level test for dsh-plugin-opencode-go.
//
// 不依赖 DSH 运行时，也不依赖任何 npm 依赖：用轻量 ctx 桩 + fetch 桩驱动插件，
// 覆盖聊天链路的会话头注入、非 Go 主机透传、路由级头模板覆盖、搜索提供方的
// 请求形状与响应映射、search.model: 'auto' 跟随聊天模型、回退链与「学会不检索」
// 缓存、错误路径、dispose 还原。
//
// 运行：node test/mechanism.test.mjs

process.env.OPENCODE_GO_API_KEY = 'oc_sk_test_key'
process.env.OPENCODE_GO_API_KEY_2 = 'oc_sk_test_key_2'
process.env.DSH_SESSION_ID = 'session-from-env'

import { readFileSync } from 'node:fs'

const { apply, mapSearchSources, normalizeConfig, Config } = await import('../lib/index.js')

// --- tiny assertion harness --------------------------------------------------
const stats = { pass: 0, fail: 0 }
function assertEq(actual, expected, label) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}
function assertTrue(value, label) {
  assertEq(Boolean(value), true, label)
}
async function catchError(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  return undefined
}
async function assertThrows(fn, needles, label) {
  const list = Array.isArray(needles) ? needles : [needles]
  const error = await catchError(fn)
  if (error === undefined) {
    console.log(`FAIL  ${label}  (no error thrown)`)
    stats.fail++
    process.exitCode = 1
    return
  }
  const missing = list.filter((needle) => !String(error.message).includes(needle))
  const ok = missing.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (message: ${String(error.message).slice(0, 110)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) {
    console.log(`      missing in message: ${JSON.stringify(missing)}`)
    process.exitCode = 1
  }
}

// --- context stub ------------------------------------------------------------
function makeCtx({ deferWeb = false, web } = {}) {
  const listeners = new Map()
  const disposers = []
  const providers = []
  const injected = []
  const logs = { warn: [], info: [] }
  const registry = new Map()
  const api = {
    logger: {
      warn: (...args) => logs.warn.push(args.join(' ')),
      info: (...args) => logs.info.push(args.join(' ')),
      error: (...args) => logs.warn.push(args.join(' ')),
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
    get() {
      return undefined
    },
    // 与真实 WebRuntime 同形：有 searchProviderId / searchProviders，注册返回 disposer。
    web: web ?? {
      searchProviderId: 'opencode-go',
      searchProviders: registry,
      registerSearchProvider(provider) {
        providers.push(provider)
        registry.set(provider.id, provider)
        return () => registry.delete(provider.id)
      },
    },
    listeners,
    logs,
    providers,
    injected,
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
  // deferWeb 模拟真实 cordis：web 服务可能晚于本插件挂载，插件必须用 ctx.inject 等它。
  if (deferWeb) {
    api.inject = (deps, callback) => {
      injected.push({ deps, callback })
    }
  }
  return api
}

// --- fetch stub --------------------------------------------------------------
const calls = []
/** reply({ url, body }) → 响应 JSON；也可返回 { status, json } 单独指定状态码与响应体。 */
let reply = () => ({ content: [] })
let replyStatus = 200
function installFetchStub() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    let body
    try {
      body = init?.body === undefined || init.body === null ? undefined : JSON.parse(init.body)
    } catch {
      body = undefined
    }
    calls.push({ url, init, body })
    const answered = reply({ url, body })
    const status = answered?.status ?? replyStatus
    return new Response(JSON.stringify(answered?.json ?? answered), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
const last = () => calls[calls.length - 1]
const lastHeaders = () => new Headers(last().init?.headers)
const lastBody = () => last().body
const searchCalls = () => calls.filter((call) => String(call.url).endsWith('/messages'))
const searchModels = () => searchCalls().map((call) => call.body?.model)
/** 按请求体里的 model 选响应；未列出的模型一律用 fallback。 */
const replyByModel = (table, fallback) => ({ body }) => {
  const entry = body?.model === undefined ? undefined : table[body.model]
  return (entry ?? fallback)()
}

/** 在 llm/stream 瀑布作用域内发一次请求，模拟 pi-ai 的真实调用形态。 */
async function runWaterfall(ctx, options, url) {
  const handler = ctx.listeners.get('llm/stream')
  const wrapped = handler(options, async function* generate() {
    const response = await fetch(url, { method: 'POST', body: '{}' })
    yield await response.text()
  })
  for await (const _chunk of wrapped) void _chunk
}

const OK_REPLY = () => ({
  stop_reason: 'end_turn',
  content: [
    {
      type: 'text',
      text: 'here you go',
      citations: [{ url: 'https://a.example/1', cited_text: '摘要 A' }],
    },
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: '2026-01-01' },
        { type: 'web_search_result', url: 'https://b.example/2' },
        { type: 'web_search_result', url: 'https://a.example/1', title: 'dup' },
      ],
    },
  ],
})
const NO_SEARCH_REPLY = () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'I can’t run a live web search from this environment.' }],
})

const originalFetch = globalThis.fetch

// --- 1. 聊天链路：llm/stream 作用域内按会话注入 -------------------------------
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 200
let ctx = makeCtx()
apply(ctx, {})
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-abc', model: 'deepseek-v4.1-flash' }, 'https://opencode.ai/zen/go/v1/chat/completions')
assertEq(lastHeaders().get('x-opencode-session'), 'session-abc', '聊天请求带 llm/stream 会话 id')
assertEq(lastHeaders().get('x-deepseek-harness-session-id'), 'session-abc', '同时打上 DSH 原生会话头')

// --- 2. 瀑布之外（辅助请求）：回退到启动环境 ---------------------------------
calls.length = 0
await fetch('https://opencode.ai/zen/go/v1/models')
assertEq(lastHeaders().get('x-opencode-session'), 'session-from-env', '辅助请求回退到 DSH_SESSION_ID')

// --- 3. 非 Go 主机完全不动 ---------------------------------------------------
calls.length = 0
await fetch('https://api.deepseek.com/anthropic/v1/messages', { headers: { 'x-api-key': 'k' } })
assertEq(lastHeaders().get('x-opencode-session'), null, '非 Go 主机不注入会话头')
assertEq(lastHeaders().get('x-api-key'), 'k', '非 Go 主机保留原有头')
ctx.dispose()

// --- 4. 路由级头模板覆盖 -----------------------------------------------------
installFetchStub()
calls.length = 0
ctx = makeCtx()
apply(ctx, { routes: { 'other-route': { 'x-session-affinity': '{provider}/{model}' } } })
await runWaterfall(ctx, { provider: 'other-route', sessionId: 'session-xyz', model: 'm1' }, 'https://opencode.ai/zen/go/v1/chat/completions')
assertEq(lastHeaders().get('x-session-affinity'), 'other-route/m1', '路由级模板渲染 provider/model')
assertEq(lastHeaders().get('x-opencode-session'), null, '命中路由时不再套用默认头模板')
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-xyz', model: 'm1' }, 'https://opencode.ai/zen/go/v1/chat/completions')
assertEq(lastHeaders().get('x-opencode-session'), 'session-xyz', '未列出的路由回落到默认头模板')
ctx.dispose()

// --- 5. 搜索提供方：请求形状与响应映射 ---------------------------------------
installFetchStub()
calls.length = 0
reply = OK_REPLY
ctx = makeCtx()
apply(ctx, {})
assertEq(ctx.providers.length, 1, '注册了一个搜索提供方')
assertEq(ctx.providers[0].id, 'opencode-go', '提供方 id')
const result = await ctx.providers[0].search({ query: 'hello world' })
assertEq(last().url, 'https://opencode.ai/zen/go/v1/messages', '搜索打的是 Go 的 Messages 端点')
assertEq(lastHeaders().get('x-opencode-session'), 'session-from-env', '搜索请求同样带会话头')
assertEq(lastHeaders().get('x-api-key'), 'oc_sk_test_key', '搜索请求带凭据')
assertEq(lastBody().model, 'claude-haiku-5-5', '默认搜索模型是 haiku（单价低且带摘要）')
assertEq(lastBody().tools[0].type, 'web_search_20250305', '带服务端 web_search 工具')
assertEq(lastBody().messages[0].content[0].text.includes('hello world'), true, '查询进入请求体')
assertEq(result.sources.length, 2, '按 URL 去重后的结果条数')
assertEq(result.sources[0].snippet, '摘要 A', 'citation 摘录映射为 snippet')
assertEq(result.sources[0].publishedAt, '2026-01-01', 'page_age 映射为 publishedAt')
assertEq(result.truncated, false, 'truncated 恒为 false（截断由 seam 负责）')
ctx.dispose()

// --- 6. 模型切换：写死 / auto 跟随 / 旧字段别名 -------------------------------
installFetchStub()
calls.length = 0
reply = OK_REPLY
ctx = makeCtx()
apply(ctx, { search: { model: 'deepseek-v4-pro' } })
await ctx.providers[0].search({ query: 'q' })
assertEq(lastBody().model, 'deepseek-v4-pro', '写死的模型 id 生效')
ctx.dispose()

installFetchStub()
calls.length = 0
ctx = makeCtx()
apply(ctx, { search: { model: 'auto' } })
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-abc', model: 'claude-haiku-5-5' }, 'https://opencode.ai/zen/go/v1/chat/completions')
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(lastBody().model, 'claude-haiku-5-5', "search.model: 'auto' 跟随最近的聊天模型")
ctx.dispose()

// 'auto' 但进程里还没见过聊天模型：用默认模型起头，不能把搜索卡住。
installFetchStub()
calls.length = 0
ctx = makeCtx()
apply(ctx, { search: { model: 'auto' } })
await ctx.providers[0].search({ query: 'q' })
assertEq(lastBody().model, 'claude-haiku-5-5', "'auto' 未见聊天模型时用默认模型兜底")
ctx.dispose()

assertEq(normalizeConfig({ search: { fallbackModel: 'kimi-k3' } }).search.fallbackModels.join(','), 'kimi-k3', '旧字段 fallbackModel 仍被当作回退链')
assertEq(normalizeConfig({}).search.fallbackModels.join(','), 'minimax-m3.1-flash-free,deepseek-v4-pro', '默认回退链')
assertEq(normalizeConfig({ search: { fallbackModels: [] } }).search.fallbackModels.length, 0, '显式空数组表示不回退')

// --- 7. 主模型没检索成时按 fallbackModels 回退 -------------------------------
installFetchStub()
calls.length = 0
reply = replyByModel({ 'claude-haiku-5-5': OK_REPLY }, NO_SEARCH_REPLY)
ctx = makeCtx()
apply(ctx, { search: { model: 'deepseek-v4.1-flash', fallbackModels: ['claude-haiku-5-5'] } })
const fallbackResult = await ctx.providers[0].search({ query: 'q' })
assertEq(searchModels().join(' → '), 'deepseek-v4.1-flash → claude-haiku-5-5', '主模型不检索时回退到 fallbackModels')
assertEq(searchCalls().length, 2, '只回退一次')
assertEq(fallbackResult.sources.length, 2, '回退模型的检索结果照常返回')
assertTrue(ctx.logs.warn.some((line) => line.includes('回退到 "claude-haiku-5-5"')), '回退时记一条 warn，便于排查')
ctx.dispose()

// --- 8. 全部候选都失败：错误里摊开每个模型的失败原因 ------------------------
installFetchStub()
calls.length = 0
reply = NO_SEARCH_REPLY
ctx = makeCtx()
apply(ctx, { search: { model: 'deepseek-v4.1-flash', fallbackModels: ['muse-spark-1.2-contributor'] } })
await assertThrows(
  () => ctx.providers[0].search({ query: 'q' }),
  ['deepseek-v4.1-flash', 'muse-spark-1.2-contributor', 'web_search_tool_result', '修法'],
  '全部失败时列出每个候选模型的失败原因与改法',
)
assertEq(searchCalls().length, 2, '两个候选模型各尝试一次')
ctx.dispose()

// --- 9. 凭据类错误不重试 -----------------------------------------------------
installFetchStub()
calls.length = 0
replyStatus = 401
reply = () => ({ error: { message: 'Authentication Fails' } })
ctx = makeCtx()
apply(ctx, { search: { fallbackModels: ['deepseek-v4-pro'] } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), ['HTTP 401', 'Authentication Fails'], 'HTTP 失败保留状态码与上游消息')
assertEq(searchCalls().length, 1, '401 不浪费时间重试回退模型')
replyStatus = 200
ctx.dispose()

// --- 10. 模型不认 Messages 协议（HTTP 400）时换下一个模型 --------------------
installFetchStub()
calls.length = 0
reply = ({ body }) =>
  body.model === 'glm-5.3'
    ? { status: 400, json: { type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } } }
    : OK_REPLY()
ctx = makeCtx()
apply(ctx, { search: { model: 'glm-5.3', fallbackModels: ['claude-haiku-5-5'] } })
const protocolResult = await ctx.providers[0].search({ query: 'q' })
assertEq(searchModels().join(' → '), 'glm-5.3 → claude-haiku-5-5', 'HTTP 400 不是终点，继续试回退模型')
assertEq(protocolResult.sources.length, 2, '换到能说 Messages 协议的模型后照样出结果')
ctx.dispose()

// --- 11. 403 区分「区域不可用」与「权限不足」 --------------------------------
installFetchStub()
calls.length = 0
reply = ({ body }) =>
  body.model === 'beam-free'
    ? { status: 403, json: { type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country' } } }
    : OK_REPLY()
ctx = makeCtx()
apply(ctx, { search: { model: 'beam-free', fallbackModels: ['claude-haiku-5-5'] } })
const regionResult = await ctx.providers[0].search({ query: 'q' })
assertEq(searchModels().join(' → '), 'beam-free → claude-haiku-5-5', 'RegionError（403）会继续试回退模型')
assertEq(regionResult.sources.length, 2, '区域受限后照样能出结果')
ctx.dispose()

installFetchStub()
calls.length = 0
reply = () => ({ status: 403, json: { type: 'error', error: { type: 'PermissionDenied', message: 'no access' } } })
ctx = makeCtx()
apply(ctx, { search: { fallbackModels: ['deepseek-v4-pro'] } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), ['HTTP 403', 'no access'], '普通 403 保留状态码与上游消息')
assertEq(searchCalls().length, 1, '普通 403 不重试（权限问题换模型没用）')
ctx.dispose()

// --- 12. 学到「不检索」后，后续搜索直接跳过它 --------------------------------
installFetchStub()
calls.length = 0
reply = replyByModel({ 'claude-haiku-5-5': OK_REPLY }, NO_SEARCH_REPLY)
ctx = makeCtx()
apply(ctx, { search: { model: 'deepseek-v4.1-flash', fallbackModels: ['claude-haiku-5-5'], noSearchCacheMinutes: 30 } })
await ctx.providers[0].search({ query: 'q' })
assertEq(searchModels().join(' → '), 'deepseek-v4.1-flash → claude-haiku-5-5', '第一次仍按顺序试')
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(searchModels().join(' → '), 'claude-haiku-5-5', '记住之后直接走回退模型，不再白跑一轮')
assertTrue(ctx.logs.warn.some((line) => line.includes('30 分钟内优先跳过它')), '学到不检索的模型时告警一次')
ctx.dispose()

// --- 13. noSearchCacheMinutes: 0 关闭记忆 -----------------------------------
installFetchStub()
calls.length = 0
reply = replyByModel({ 'claude-haiku-5-5': OK_REPLY }, NO_SEARCH_REPLY)
ctx = makeCtx()
apply(ctx, { search: { model: 'deepseek-v4.1-flash', fallbackModels: ['claude-haiku-5-5'], noSearchCacheMinutes: 0 } })
await ctx.providers[0].search({ query: 'q' })
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(searchCalls().length, 2, '缓存关闭时每次搜索都按原顺序试')
ctx.dispose()

// --- 14. 检索工具报错（对象形态）与 max_tokens 提示 --------------------------
const toolError = await catchError(() =>
  mapSearchSources({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] }, 'm1'),
)
assertEq(toolError?.code, 'search-error', '工具错误项标记为 search-error')
assertTrue(String(toolError?.message).includes('max_uses_exceeded'), '错误里带上上游 error_code')
assertTrue(String(toolError?.message).includes('m1'), '错误里带上是哪个模型')

const maxTokens = await catchError(() => mapSearchSources({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '…' }] }, 'deepseek-v4.1-flash'))
assertEq(maxTokens?.code, 'no-search', '没有检索块时标记为可回退的 no-search')
assertTrue(String(maxTokens?.message).includes('maxTokens'), 'stop_reason=max_tokens 时提示调大 search.maxTokens')

// --- 15. 会话头在搜索路径上的来源优先级 --------------------------------------
installFetchStub()
calls.length = 0
reply = OK_REPLY
ctx = makeCtx()
apply(ctx, {})
delete process.env.DSH_SESSION_ID
await ctx.providers[0].search({ query: 'q' })
assertEq(lastHeaders().get('x-opencode-session')?.startsWith('dsh-opencode-go-'), true, '无任何会话来源时回落到进程级稳定 id')
process.env.DSH_SESSION_ID = 'session-from-env'
ctx.dispose()

// --- 16. dispose 还原 globalThis.fetch ---------------------------------------
assertEq(globalThis.fetch !== undefined, true, 'dispose 后 fetch 仍可用')
assertEq(globalThis.fetch === originalFetch, false, '（桩位不同属正常：本测试在插件之前就替换了 fetch）')

// --- 17. web 服务晚挂载：ctx.inject 延迟注册 ---------------------------------
ctx = makeCtx({ deferWeb: true })
apply(ctx, {})
assertEq(ctx.providers.length, 0, 'web 尚未就绪时不抢先注册')
assertEq(ctx.injected[0]?.deps?.[0], 'web', '声明等待 web 服务')
const lateRegistry = new Map()
ctx.injected[0].callback({
  web: {
    searchProviderId: 'opencode-go',
    searchProviders: lateRegistry,
    registerSearchProvider(provider) {
      ctx.providers.push(provider)
      lateRegistry.set(provider.id, provider)
      return () => lateRegistry.delete(provider.id)
    },
  },
})
assertEq(ctx.providers.length, 1, 'web 就绪后完成注册')
assertEq(lateRegistry.get('opencode-go') !== undefined, true, 'web 就绪后接管搜索选择')
ctx.dispose()

// --- 18. HMR 重复注册：替换旧注册而不是让 apply 崩掉 ------------------------
installFetchStub()
const staleProvider = { id: 'opencode-go', available: () => true, search: async () => ({ sources: [], truncated: false }) }
const registry = new Map([['opencode-go', staleProvider]])
let registrations = 0
ctx = makeCtx({
  web: {
    searchProviderId: 'opencode-go',
    searchProviders: registry,
    registerSearchProvider(provider) {
      if (registry.has(provider.id)) {
        const error = new Error(`a web provider with id "${provider.id}" is already registered`)
        error.code = 'WEB_DUPLICATE_PROVIDER'
        throw error
      }
      registrations += 1
      registry.set(provider.id, provider)
      return () => registry.delete(provider.id)
    },
  },
})
apply(ctx, {})
assertEq(registrations, 1, '重复注册时先摘掉旧条目再挂新的')
assertEq(registry.get('opencode-go') !== staleProvider, true, '注册表里换成了本次的新提供方')
assertTrue(ctx.logs.warn.some((line) => line.includes('替换旧注册')), '替换时留下一条 warn')
ctx.dispose()

ctx = makeCtx({
  web: {
    searchProviderId: 'opencode-go',
    registerSearchProvider() {
      const error = new Error('a web provider with id "opencode-go" is already registered')
      error.code = 'WEB_DUPLICATE_PROVIDER'
      throw error
    },
  },
})
apply(ctx, {})
assertTrue(ctx.logs.warn.some((line) => line.includes('无法替换')), '拿不到注册表时告警保留旧实现，且 apply 不抛错')
ctx.dispose()

// --- 19. 其它注册异常也只告警，不影响插件加载 ------------------------------
ctx = makeCtx({
  web: {
    searchProviderId: 'opencode-go',
    registerSearchProvider() {
      throw new Error('boom')
    },
  },
})
apply(ctx, {})
assertTrue(ctx.logs.warn.some((line) => line.includes('注册搜索提供方失败')), '未知注册异常同样降级为告警')
ctx.dispose()

// --- 19. 错误码对齐 web seam 词汇 -------------------------------------------
installFetchStub()
calls.length = 0
reply = OK_REPLY
ctx = makeCtx({
  web: {
    searchProviderId: 'opencode-go',
    registerSearchProvider(provider) {
      ctx.providers.push(provider)
    },
  },
})
apply(ctx, {})
const aborted = new AbortController()
aborted.abort()
const abortError = await catchError(() => ctx.providers[0].search({ query: 'q' }, aborted.signal))
assertEq(abortError?.code, 'WEB_ABORTED', '取消错误带 WEB_ABORTED（超时策略按它路由）')
assertEq(searchCalls().length, 0, '已取消的搜索不再发请求')
ctx.dispose()

installFetchStub()
calls.length = 0
reply = NO_SEARCH_REPLY
ctx = makeCtx()
apply(ctx, { search: { fallbackModels: [] } })
const finalError = await catchError(() => ctx.providers[0].search({ query: 'q' }))
assertEq(finalError?.code, 'WEB_PROVIDER_ERROR', '最终失败带 WEB_PROVIDER_ERROR')
ctx.dispose()

installFetchStub()
const savedKey = process.env.OPENCODE_GO_API_KEY
delete process.env.OPENCODE_GO_API_KEY
ctx = makeCtx()
apply(ctx, {})
const credentialError = await catchError(() => ctx.providers[0].search({ query: 'q' }))
assertEq(credentialError?.code, 'WEB_PROVIDER_CREDENTIAL_MISSING', '缺凭据时带 WEB_PROVIDER_CREDENTIAL_MISSING')
process.env.OPENCODE_GO_API_KEY = savedKey
ctx.dispose()

// --- 20. 关闭插件 = 回到原始配置：pin 与插件同属一个 bundle 层 --------------
const bundlePatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assertTrue(/^- id: web$/mu.test(bundlePatch), 'bundle 层里保留 web 的 searchProvider 指向')
assertTrue(bundlePatch.includes('searchProvider: opencode-go'), '指向本插件的提供方 id')
assertTrue(bundlePatch.includes('fetchProvider: opencode-go-fetch'), '抓取指向本插件的提供方（fake-ip / 透明代理环境）')
assertEq(bundlePatch.includes('enabled:'), false, '不再有会留下悬空指向的 enabled 开关')

// --- 21. 插件卸载时摘掉自己的注册 -------------------------------------------
installFetchStub()
ctx = makeCtx()
apply(ctx, {})
assertEq(ctx.web.searchProviders.get('opencode-go') !== undefined, true, 'apply 后 seam 里有本插件的提供方')
ctx.dispose()
assertEq(ctx.web.searchProviders.get('opencode-go'), undefined, 'dispose 后 seam 里不再有本插件的提供方')

// --- 22. 开关 1：modelFallback: false 只试主模型 ----------------------------
installFetchStub()
calls.length = 0
reply = NO_SEARCH_REPLY
ctx = makeCtx()
apply(ctx, { search: { model: 'm-primary', fallbackModels: ['m-second'], modelFallback: false } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), ['m-primary'], '关闭模型回退后仍保留失败原因')
assertEq(searchModels().join(','), 'm-primary', '关闭模型回退后不再试 fallbackModels')
ctx.dispose()

// --- 24. 开关 2：officialFallback 打开时用官方 DeepSeek 兜底 ----------------
const savedDeepseekKey = process.env.DEEPSEEK_API_KEY
process.env.DEEPSEEK_API_KEY = 'sk-official-test'

installFetchStub()
calls.length = 0
reply = ({ url }) => (String(url).includes('api.deepseek.com') ? OK_REPLY() : NO_SEARCH_REPLY())
ctx = makeCtx()
apply(ctx, { search: { model: 'm-primary', fallbackModels: [], officialFallback: true } })
const officialResult = await ctx.providers[0].search({ query: 'q' })
assertEq(last().url, 'https://api.deepseek.com/anthropic/v1/messages', 'Go 全失败后打官方端点')
assertEq(lastBody().model, 'deepseek-v4-flash', '官方兜底用原始搜索模型')
assertEq(lastHeaders().get('x-api-key'), 'sk-official-test', '官方兜底用 DEEPSEEK_API_KEY')
assertEq(officialResult.sources.length, 2, '官方兜底的结果照常返回')
assertTrue(ctx.logs.warn.some((line) => line.includes('官方 DeepSeek 兜底')), '触发官方兜底时告警')
ctx.dispose()

installFetchStub()
calls.length = 0
reply = NO_SEARCH_REPLY
ctx = makeCtx()
apply(ctx, { search: { model: 'm-primary', fallbackModels: [] } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), ['web_search_tool_result'], '默认不启用官方兜底')
assertEq(calls.some((call) => String(call.url).includes('api.deepseek.com')), false, '默认不会打官方端点')
ctx.dispose()

installFetchStub()
calls.length = 0
reply = ({ url }) => (String(url).includes('api.deepseek.com') ? OK_REPLY() : NO_SEARCH_REPLY())
ctx = makeCtx()
apply(ctx, { search: { model: 'm-primary', fallbackModels: [], officialFallback: true } })
ctx.get = (name) => (name === 'deepseekAccount' ? { resolveToken: async () => 'acct-token-123' } : undefined)
await ctx.providers[0].search({ query: 'q' })
assertEq(lastHeaders().get('x-dsh-auth-token'), 'acct-token-123', '有账号登录态时官方兜底用它鉴权')
assertEq(lastHeaders().get('x-api-key'), null, '有账号登录态时不再回退到 API key')
ctx.dispose()

installFetchStub()
calls.length = 0
reply = ({ url }) => (String(url).includes('api.deepseek.com') ? OK_REPLY() : NO_SEARCH_REPLY())
ctx = makeCtx()
apply(ctx, { search: { model: 'm-primary', fallbackModels: [], officialFallback: true } })
const savedDeepseekKeyForAuth = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY
const missingOfficial = await catchError(() => ctx.providers[0].search({ query: 'q' }))
assertEq(missingOfficial?.code, 'WEB_PROVIDER_CREDENTIAL_MISSING', '账号与 key 都没有时给出凭据缺失')
process.env.DEEPSEEK_API_KEY = savedDeepseekKeyForAuth
ctx.dispose()

installFetchStub()
calls.length = 0
reply = ({ url }) => (String(url).includes('api.deepseek.com') ? OK_REPLY() : NO_SEARCH_REPLY())
ctx = makeCtx()
apply(ctx, { search: { officialFallback: true } })
const savedGoKeyForAuth = process.env.OPENCODE_GO_API_KEY
delete process.env.OPENCODE_GO_API_KEY
const noGoKeyResult = await ctx.providers[0].search({ query: 'q' })
assertEq(searchCalls().length, 1, '没有 Go 凭据时跳过 Go，只打一次官方')
assertEq(noGoKeyResult.sources.length, 2, '没有 Go 凭据也能靠官方兜底出结果')
process.env.OPENCODE_GO_API_KEY = savedGoKeyForAuth
ctx.dispose()

if (savedDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
else process.env.DEEPSEEK_API_KEY = savedDeepseekKey

// --- 26. available()：配置不再指向本插件时自动让路，避免两个提供方打架 ----
installFetchStub()
ctx = makeCtx()
apply(ctx, {})
assertEq(ctx.providers[0].available(), true, '配置指向本插件时可用')
ctx.web.searchProviderId = 'deepseek-official'
assertEq(ctx.providers[0].available(), false, '配置指向别人时让路，避免两个可用提供方触发歧义')
ctx.dispose()

installFetchStub()
ctx = makeCtx({
  web: {
    config: { searchProvider: { get: () => 'deepseek-official' } },
    registerSearchProvider: (provider) => ctx.providers.push(provider),
  },
})
apply(ctx, {})
assertEq(ctx.providers[0].available(), false, '0.2.1 的 config accessor 也能读出来并让路')
ctx.dispose()

installFetchStub()
ctx = makeCtx({ web: { registerSearchProvider: (provider) => ctx.providers.push(provider) } })
apply(ctx, {})
assertEq(ctx.providers[0].available(), true, '读不到选择时不乱猜，保持可用')
ctx.dispose()

// --- 27. 多 key：优先级、会话粘滞、失败轮换 ---------------------------------
const CHAT_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const KEY_CONFIG = {
  keys: [
    { ref: 'OPENCODE_GO_API_KEY', priority: 10 },
    { ref: 'OPENCODE_GO_API_KEY_2', priority: 5 },
  ],
}

// 未配置 keys 时保持旧的单 key 行为：不碰 Authorization。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 200
ctx = makeCtx()
apply(ctx, {})
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-legacy', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), null, '未配置 keys 时不改 Authorization')
ctx.dispose()

// 不在 Go API 路径下的 opencode.ai 请求不注入 key。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 200
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
await fetch('https://opencode.ai/docs/go')
assertEq(lastHeaders().get('authorization'), null, '非 Go API 路径不注入 key')
ctx.dispose()

// 会话粘滞：同一 session 连续两次都用最高优先级 key。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 200
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-sticky', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key', '多 key：优先用最高优先级')
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-sticky', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key', '同一对话沿用同一个 key')
ctx.dispose()

// 连续两次 5xx 后才换到下一个 key。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 500
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-failover', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key', '第一次失败仍用原 key')
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-failover', model: 'm' }, CHAT_URL)
replyStatus = 200
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-failover', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key_2', '连续失败达到阈值后换 key')
assertTrue(ctx.logs.warn.some((line) => line.includes('连续失败')), '换 key 时打日志')
ctx.dispose()

// 401 立即换。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 401
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-auth', model: 'm' }, CHAT_URL)
replyStatus = 200
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-auth', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key_2', '401 立即换 key')
ctx.dispose()

// 搜索请求也走同一个 key 池。
installFetchStub()
calls.length = 0
reply = OK_REPLY
replyStatus = 200
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
await ctx.providers[0].search({ query: 'q' })
assertEq(lastHeaders().get('x-api-key'), 'oc_sk_test_key', '搜索用多 key 池里的 key')
assertEq(lastHeaders().get('authorization'), 'Bearer oc_sk_test_key', '搜索的 Authorization 同样覆盖')
ctx.dispose()

// 搜索遇到 401 时换 key 再试下一个模型。
installFetchStub()
calls.length = 0
let search401Count = 0
reply = () =>
  search401Count++ === 0
    ? { status: 401, json: { error: { message: 'invalid key' } } }
    : OK_REPLY()
replyStatus = 200
ctx = makeCtx()
apply(ctx, KEY_CONFIG)
const retriedSearch = await ctx.providers[0].search({ query: 'q' })
assertEq(retriedSearch.sources.length, 2, '搜索 401 后换 key 仍能出结果')
assertEq(lastHeaders().get('x-api-key'), 'oc_sk_test_key_2', '搜索 401 后下一次尝试用新 key')
ctx.dispose()

// patchFetch: false 时由搜索提供方自己记录失败，仍能轮换。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 500
ctx = makeCtx()
apply(ctx, { ...KEY_CONFIG, patchFetch: false, search: { model: 'm-1', fallbackModels: ['m-2', 'm-3'] } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), [], '多 key 且关闭 fetch 包装时搜索失败可控')
assertEq(searchCalls().map((call) => new Headers(call.init.headers).get('x-api-key')).join(','), 'oc_sk_test_key,oc_sk_test_key,oc_sk_test_key_2', '关闭 fetch 包装后搜索仍能按失败次数轮换 key')
ctx.dispose()

// 凭据服务里的引用也能作为多 key 来源。
installFetchStub()
calls.length = 0
reply = () => ({ ok: true })
replyStatus = 200
ctx = makeCtx()
ctx.get = (service) =>
  service === 'credentials'
    ? {
        resolve: async (ref) => ({ value: ref === 'cred-a' ? 'key-a' : ref === 'cred-b' ? 'key-b' : undefined }),
      }
    : undefined
apply(ctx, {
  keys: [
    { ref: 'cred-a', priority: 10 },
    { ref: 'cred-b', priority: 5 },
  ],
})
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-cred', model: 'm' }, CHAT_URL)
assertEq(lastHeaders().get('authorization'), 'Bearer key-a', '从 credentials 服务解析多 key')
ctx.dispose()

// 配置归一化。
assertEq(
  normalizeConfig({ keys: ['a', { ref: 'b', priority: 2 }] }).keys.map((entry) => entry.ref).join(','),
  'b,a',
  'normalizeConfig 归一化 keys',
)
assertEq(normalizeConfig({}).keyFailoverAfter, 2, '默认失败阈值是 2')

// --- 28. Config（插件页表单）与 volatile 访问器 -----------------------------
assertEq(Config === undefined || typeof Config === 'object', true, 'Config 要么是 schema，要么缺失但不影响加载')
const accessor = (value) => ({ get: () => value })
const fromForm = normalizeConfig({
  search: { model: accessor('auto'), modelFallback: accessor(false), fallbackModels: accessor(['m-a']) },
})
assertEq(fromForm.search.model, 'auto', '表单写入的访问器被还原成普通值')
assertEq(fromForm.search.modelFallback, false, '布尔访问器同样还原')
assertEq(fromForm.search.fallbackModels.join(','), 'm-a', '数组访问器同样还原')
assertEq(normalizeConfig({ search: { model: 'x' } }).search.modelFallback, true, '未配置时回退开关保持默认')

console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
