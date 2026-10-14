// Mechanism-level test for dsh-plugin-opencode-go.
//
// 不依赖 DSH 运行时，也不依赖任何 npm 依赖：用轻量 ctx 桩 + fetch 桩驱动插件，
// 覆盖聊天链路的会话头注入、非 Go 主机透传、路由级头模板覆盖、搜索提供方的
// 请求形状与响应映射、search.model: 'auto' 跟随聊天模型、错误路径、dispose 还原。
//
// 运行：node test/mechanism.test.mjs

process.env.OPENCODE_GO_API_KEY = 'oc_sk_test_key'
process.env.DSH_SESSION_ID = 'session-from-env'

const { apply } = await import('../lib/index.js')

// --- tiny assertion harness --------------------------------------------------
const stats = { pass: 0, fail: 0 }
function assertEq(actual, expected, label) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}
function assertThrows(fn, needle, label) {
  return fn().then(
    () => {
      console.log(`FAIL  ${label}  (no error thrown)`)
      stats.fail++
      process.exitCode = 1
    },
    (error) => {
      const ok = String(error.message).includes(needle)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (message: ${String(error.message).slice(0, 90)})`)
      ok ? stats.pass++ : stats.fail++
      if (!ok) process.exitCode = 1
    },
  )
}

// --- context stub ------------------------------------------------------------
function makeCtx({ deferWeb = false } = {}) {
  const listeners = new Map()
  const disposers = []
  const providers = []
  const injected = []
  const api = {
    logger: { warn() {}, info() {}, error() {} },
    on(event, handler) {
      listeners.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
    get() {
      return undefined
    },
    web: {
      registerSearchProvider(provider) {
        providers.push(provider)
      },
    },
    listeners,
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
let reply = () => ({ content: [] })
let replyStatus = 200
function installFetchStub() {
  globalThis.fetch = async (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : input.url, init })
    return new Response(JSON.stringify(reply()), {
      status: replyStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
}
const last = () => calls[calls.length - 1]
const lastHeaders = () => new Headers(last().init?.headers)
const lastBody = () => JSON.parse(last().init.body)

/** 在 llm/stream 瀑布作用域内发一次请求，模拟 pi-ai 的真实调用形态。 */
async function runWaterfall(ctx, options, url) {
  const handler = ctx.listeners.get('llm/stream')
  const wrapped = handler(options, async function* generate() {
    const response = await fetch(url, { method: 'POST', body: '{}' })
    yield await response.text()
  })
  for await (const _chunk of wrapped) void _chunk
}

const SEARCH_REPLY = () => ({
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
reply = SEARCH_REPLY
ctx = makeCtx()
apply(ctx, {})
assertEq(ctx.providers.length, 1, '注册了一个搜索提供方')
assertEq(ctx.providers[0].id, 'opencode-go', '提供方 id')
const result = await ctx.providers[0].search({ query: 'hello world' })
assertEq(last().url, 'https://opencode.ai/zen/go/v1/messages', '搜索打的是 Go 的 Messages 端点')
assertEq(lastHeaders().get('x-opencode-session'), 'session-from-env', '搜索请求同样带会话头')
assertEq(lastHeaders().get('x-api-key'), 'oc_sk_test_key', '搜索请求带凭据')
assertEq(lastBody().model, 'deepseek-v4.1-flash', '默认搜索模型')
assertEq(lastBody().tools[0].type, 'web_search_20250305', '带服务端 web_search 工具')
assertEq(lastBody().messages[0].content[0].text.includes('hello world'), true, '查询进入请求体')
assertEq(result.sources.length, 2, '按 URL 去重后的结果条数')
assertEq(result.sources[0].snippet, '摘要 A', 'citation 摘录映射为 snippet')
assertEq(result.sources[0].publishedAt, '2026-01-01', 'page_age 映射为 publishedAt')
assertEq(result.truncated, false, 'truncated 恒为 false（截断由 seam 负责）')

// --- 6. 模型切换：写死 / auto 跟随聊天模型 -----------------------------------
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(lastBody().model, 'deepseek-v4.1-flash', '写死的模型 id 生效')
ctx.dispose()

ctx = makeCtx()
apply(ctx, { search: { model: 'auto' } })
await runWaterfall(ctx, { provider: 'opencode-go', sessionId: 'session-abc', model: 'glm-5.3' }, 'https://opencode.ai/zen/go/v1/chat/completions')
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(lastBody().model, 'glm-5.3', "search.model: 'auto' 跟随最近的聊天模型")

// --- 7. 错误路径 -------------------------------------------------------------
reply = () => ({ content: [{ type: 'text', text: 'no search happened' }] })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), 'web_search_tool_result', '模型没触发检索时给出可操作报错')
replyStatus = 401
reply = () => ({ error: { message: 'Authentication Fails' } })
await assertThrows(() => ctx.providers[0].search({ query: 'q' }), 'HTTP 401', 'HTTP 失败保留状态码与上游消息')
replyStatus = 200

// --- 8. 会话头在搜索路径上的来源优先级 ---------------------------------------
delete process.env.DSH_SESSION_ID
reply = SEARCH_REPLY
calls.length = 0
await ctx.providers[0].search({ query: 'q' })
assertEq(lastHeaders().get('x-opencode-session')?.startsWith('dsh-opencode-go-'), true, '无任何会话来源时回落到进程级稳定 id')
process.env.DSH_SESSION_ID = 'session-from-env'

// --- 9. dispose 还原 globalThis.fetch ---------------------------------------
ctx.dispose()
assertEq(globalThis.fetch !== undefined && globalThis.fetch.constructor.name !== 'Symbol', true, 'dispose 后 fetch 可用')
assertEq(globalThis.fetch === originalFetch, false, '（桩位不同属正常：本测试在插件之前就替换了 fetch）')

// --- 10. web 服务晚挂载：ctx.inject 延迟注册 ---------------------------------
ctx = makeCtx({ deferWeb: true })
apply(ctx, {})
assertEq(ctx.providers.length, 0, 'web 尚未就绪时不抢先注册')
assertEq(ctx.injected[0]?.deps?.[0], 'web', '声明等待 web 服务')
ctx.injected[0].callback({ web: { registerSearchProvider: (provider) => ctx.providers.push(provider) } })
assertEq(ctx.providers.length, 1, 'web 就绪后完成注册')
ctx.dispose()

console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
