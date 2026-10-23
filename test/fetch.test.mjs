// 抓取提供方（lib/fetch.js）的机制测试。
//
// 不需要 DSH 运行时，也不需要任何 npm 依赖：起一个本地 HTTP 服务当被测站点，
// 用真实的全局 fetch 走完「解析 → 请求 → 截断 → 解码」全流程；IP 字面量与 URL
// 校验这类纯逻辑直接调导出的函数。
//
// 运行：node test/fetch.test.mjs

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const {
  FETCH_PROVIDER_ID,
  FETCH_DEFAULTS,
  assertAllowedTarget,
  attachFetchProvider,
  classifyContentType,
  configuredFetchProviderId,
  createFetchProvider,
  isNonPublicLiteral,
  normalizeFetchConfig,
  parseCharset,
} = await import('../lib/fetch.js')

// --- tiny assertion harness --------------------------------------------------
const stats = { pass: 0, fail: 0 }
function assertEq(actual, expected, label) {
  const ok = Object.is(actual, expected)
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
async function assertThrowsCode(fn, code, label) {
  const error = await catchError(fn)
  const ok = error !== undefined && error.code === code
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${error?.code ?? 'no error'}, want ${code})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) {
    process.exitCode = 1
    if (error !== undefined) console.log(`      message: ${String(error.message).slice(0, 160)}`)
  }
}

// --- fixture server ----------------------------------------------------------
// 路由：
//   /html          200 text/html; charset=utf-8
//   /text          200 text/plain
//   /json          200 application/json
//   /binary        200 image/png（应当被拒）
//   /latin1        200 text/plain; charset=iso-8859-1
//   /big           200 text/plain，1 MB
//   /redirect      302 → /html（相对 Location 之外的绝对形式各测一次）
//   /redirect-cross 302 → 另一个 origin 的 /html
//   /loop          302 → /loop
//   /huge-header   200 text/plain，Content-Length 声明 10 MB
//   /missing       404 text/html
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid')
  const text = (body, type, status = 200, headers = {}) => {
    response.writeHead(status, { 'content-type': type, ...headers })
    response.end(body)
  }

  switch (url.pathname) {
    case '/html':
      return text('<html><body><h1>hello</h1></body></html>', 'text/html; charset=utf-8')
    case '/text':
      return text('plain text body', 'text/plain')
    case '/json':
      return text(JSON.stringify({ ok: true }), 'application/json')
    case '/binary':
      return text(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    case '/latin1':
      return text(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=iso-8859-1')
    case '/big':
      return text('x'.repeat(1024 * 1024), 'text/plain')
    case '/redirect':
      response.writeHead(302, { location: '/html' })
      return response.end()
    case '/redirect-cross':
      response.writeHead(302, { location: `${crossOrigin}/html` })
      return response.end()
    case '/loop':
      response.writeHead(302, { location: '/loop' })
      return response.end()
    case '/to-literal':
      response.writeHead(302, { location: 'http://127.0.0.1:9/internal' })
      return response.end()
    case '/huge-header':
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(10 * 1024 * 1024) })
      return response.end('small')
    case '/missing':
      return text('not found', 'text/html', 404)
    default:
      return text('unknown', 'text/plain', 500)
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const crossServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<html><body>cross</body></html>')
})
await new Promise((resolve) => crossServer.listen(0, '127.0.0.1', resolve))
const crossOrigin = `http://127.0.0.1:${crossServer.address().port}`

/** 测试用提供方：默认放行 IP 字面量，否则连不到 127.0.0.1 上的 fixture。 */
function makeProvider(overrides = {}) {
  return createFetchProvider({ allowIpLiterals: true, ...overrides })
}

// --- 1. 默认值与配置归一 -----------------------------------------------------
assertEq(FETCH_PROVIDER_ID, 'opencode-go-fetch', '提供方 id 与 bundle patch 约定一致')
assertEq(normalizeFetchConfig().maxRedirects, FETCH_DEFAULTS.maxRedirects, '缺省沿用默认重定向上限')
assertEq(normalizeFetchConfig({ maxBodyChars: 10 }).maxBodyChars, 10, '显式值覆盖默认')
assertEq(normalizeFetchConfig({ maxBodyChars: -1 }).maxBodyChars, FETCH_DEFAULTS.maxBodyChars, '非法值落回默认')
assertEq(normalizeFetchConfig({ maxRedirects: 0 }).maxRedirects, 0, 'maxRedirects: 0 合法（不跟重定向）')
assertEq(normalizeFetchConfig({ timeoutMs: Number.NaN }).timeoutMs, FETCH_DEFAULTS.timeoutMs, 'NaN 落回默认')
assertEq(normalizeFetchConfig({ allowIpLiterals: true }).allowIpLiterals, true, 'allowIpLiterals 透传')
assertEq(normalizeFetchConfig({ provider: 'custom' }).provider, 'custom', 'provider id 可覆盖')

// --- 2. content-type / charset 分类 -----------------------------------------
assertEq(classifyContentType('text/html; charset=utf-8'), 'html', 'text/html → html')
assertEq(classifyContentType('application/xhtml+xml'), 'html', 'xhtml → html')
assertEq(classifyContentType('text/plain'), 'text', 'text/plain → text')
assertEq(classifyContentType('application/json; charset=utf-8'), 'text', 'json → text')
assertEq(classifyContentType('application/problem+json'), 'text', '结构化后缀 +json → text')
assertEq(classifyContentType('image/png'), undefined, '二进制 → 不支持')
assertEq(classifyContentType(null), undefined, '缺 Content-Type → 不支持')
assertEq(parseCharset('text/html; charset=UTF-8'), 'utf-8', 'charset 小写归一')
assertEq(parseCharset('text/html'), undefined, '无 charset → undefined')

// --- 3. IP 字面量判定 --------------------------------------------------------
for (const [address, expected] of [
  ['127.0.0.1', true],
  ['10.1.2.3', true],
  ['172.16.0.9', true],
  ['192.168.1.1', true],
  ['169.254.169.254', true],
  ['100.64.0.7', true],
  ['198.18.0.197', true],
  ['::1', true],
  ['fc00::b7', true],
  ['fe80::1', true],
  ['::ffff:127.0.0.1', true],
  ['1.1.1.1', false],
  ['2606:4700::1111', false],
  ['github.com', false],
]) {
  assertEq(isNonPublicLiteral(address), expected, `${address} → ${expected ? '非公网' : '公网/域名'}`)
}

// --- 4. URL 校验 -------------------------------------------------------------
assertThrowsCode(() => assertAllowedTarget('ftp://example.com/'), 'WEB_INVALID_URL', '拒绝非 http(s) 协议')
assertThrowsCode(() => assertAllowedTarget('not a url'), 'WEB_INVALID_URL', '拒绝无法解析的 URL')
assertThrowsCode(() => assertAllowedTarget('http://user:pass@example.com/'), 'WEB_BLOCKED_URL', '拒绝 URL 内嵌凭据')
assertThrowsCode(() => assertAllowedTarget('http://192.168.1.1/'), 'WEB_BLOCKED_URL', '默认拒绝内网 IP 字面量')
assertThrowsCode(() => assertAllowedTarget('http://[::1]:8080/'), 'WEB_BLOCKED_URL', '默认拒绝 IPv6 环回')
assertEq(assertAllowedTarget('http://192.168.1.1/', { allowIpLiterals: true }).hostname, '192.168.1.1', '开关可放行内网字面量')
assertEq(assertAllowedTarget('https://github.com/a?b=1').hostname, 'github.com', '域名不受字面量规则影响')

// --- 5. 真实请求：html / text / 非 2xx ---------------------------------------
{
  const provider = makeProvider()
  const html = await provider.fetch({ url: `${origin}/html` })
  assertEq(html.statusCode, 200, 'html：状态码透传')
  assertEq(html.body.kind, 'html', 'html：分类为 html')
  assertTrue(html.body.content.includes('<h1>hello</h1>'), 'html：正文原样返回（markdown 由 dsh-tool-web 转）')
  assertEq(html.truncated, false, 'html：未截断')
  assertEq(html.url, `${origin}/html`, 'html：返回最终 URL')

  const text = await provider.fetch({ url: `${origin}/text` })
  assertEq(text.body.kind, 'text', 'text：分类为 text')

  const json = await provider.fetch({ url: `${origin}/json` })
  assertEq(json.body.kind, 'text', 'json：按文本处理')
  assertEq(json.body.content, '{"ok":true}', 'json：正文未变形')

  const latin = await provider.fetch({ url: `${origin}/latin1` })
  assertEq(latin.body.content, 'café', '按声明 charset 解码（iso-8859-1）')

  const missing = await provider.fetch({ url: `${origin}/missing` })
  assertEq(missing.statusCode, 404, '非 2xx 是结果而不是异常')
  assertEq(missing.body.kind, 'html', '404 的正文照常解码')
}

// --- 6. 拒绝的类型与声明长度 -------------------------------------------------
{
  const provider = makeProvider()
  await assertThrowsCode(() => provider.fetch({ url: `${origin}/binary` }), 'WEB_UNSUPPORTED_CONTENT_TYPE', '拒绝二进制 Content-Type')
  await assertThrowsCode(() => provider.fetch({ url: `${origin}/huge-header` }), 'WEB_FETCH_TOO_LARGE', 'Content-Length 超上限时立即拒绝')
}

// --- 7. 字节 / 字符截断 ------------------------------------------------------
{
  const byBytes = await makeProvider({ maxResponseBytes: 1024 }).fetch({ url: `${origin}/big` })
  assertEq(byBytes.truncated, true, '超过字节上限：truncated 为 true')
  assertEq(byBytes.body.content.length, 1024, '超过字节上限：正文被截到上限')

  const byChars = await makeProvider({ maxBodyChars: 5 }).fetch({ url: `${origin}/text` })
  assertEq(byChars.truncated, true, '超过字符上限：truncated 为 true')
  assertEq(byChars.body.content, 'plain', '超过字符上限：正文被截到上限')
}

// --- 8. 重定向 ---------------------------------------------------------------
{
  const provider = makeProvider()
  const followed = await provider.fetch({ url: `${origin}/redirect` })
  assertEq(followed.url, `${origin}/html`, '相对 Location：跟随后返回最终 URL')
  assertEq(followed.statusCode, 200, '相对 Location：拿到最终响应')

  const cross = await provider.fetch({ url: `${origin}/redirect-cross` })
  assertEq(cross.body.content.includes('cross'), true, '跨域重定向：允许跟随（与内置的同源限制不同）')

  await assertThrowsCode(() => provider.fetch({ url: `${origin}/loop` }), 'WEB_REDIRECT_BLOCKED', '超过重定向上限：报 WEB_REDIRECT_BLOCKED')
  await assertThrowsCode(
    () => makeProvider({ maxRedirects: 0 }).fetch({ url: `${origin}/redirect` }),
    'WEB_REDIRECT_BLOCKED',
    'maxRedirects: 0 时一站也不跟',
  )
  await assertThrowsCode(
    () =>
      makeProvider({ allowIpLiterals: false }).fetch({
        url: `http://localhost:${server.address().port}/to-literal`,
      }),
    'WEB_BLOCKED_URL',
    '重定向到内网字面量：每一跳都重新校验',
  )
}

// --- 9. 取消与超时 -----------------------------------------------------------
{
  const provider = makeProvider()
  const aborted = new AbortController()
  aborted.abort()
  await assertThrowsCode(() => provider.fetch({ url: `${origin}/html` }, aborted.signal), 'WEB_ABORTED', '已取消的 signal → WEB_ABORTED')

  const slow = createFetchProvider({ allowIpLiterals: true, timeoutMs: 50 })
  const hanging = createServer(() => {
    /* 故意不响应 */
  })
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  const hangingOrigin = `http://127.0.0.1:${hanging.address().port}`
  await assertThrowsCode(() => slow.fetch({ url: `${hangingOrigin}/slow` }), 'WEB_FETCH_TIMEOUT', '超过 timeoutMs → WEB_FETCH_TIMEOUT')
  hanging.closeAllConnections?.()
  await new Promise((resolve) => hanging.close(resolve))
}

// --- 10. available() 跟随 web 选择 ------------------------------------------
{
  const provider = createFetchProvider({})
  assertEq(provider.available(), true, '读不到选择时保持可用')
  provider.bindScope({ web: { config: { fetchProvider: { get: () => 'http' } } } })
  assertEq(provider.available(), false, '0.2.1 的 config accessor：指向别人时让路')
  provider.bindScope({ web: { config: { fetchProvider: { get: () => FETCH_PROVIDER_ID } } } })
  assertEq(provider.available(), true, '指向自己时可用')
  provider.bindScope({ web: { fetchProviderId: 'http' } })
  assertEq(provider.available(), false, '0.2.0 的字段形式也能读出来')
  assertEq(configuredFetchProviderId({ web: { config: { fetchProvider: 'x' } } }), 'x', '字符串形式的配置也支持')
}

// --- 11. attach：注册、HMR 替换、未知异常降级 -------------------------------
function makeCtx(web) {
  const logs = { warn: [], info: [] }
  return {
    logger: {
      warn: (...args) => logs.warn.push(args.join(' ')),
      info: (...args) => logs.info.push(args.join(' ')),
    },
    web,
    logs,
  }
}
{
  const registry = new Map()
  const web = {
    fetchProviders: registry,
    registerFetchProvider(provider) {
      if (registry.has(provider.id)) {
        const error = new Error(`a web provider with id "${provider.id}" is already registered`)
        error.code = 'WEB_DUPLICATE_PROVIDER'
        throw error
      }
      registry.set(provider.id, provider)
      return () => registry.delete(provider.id)
    },
  }
  const ctx = makeCtx(web)
  const provider = createFetchProvider({})
  const dispose = attachFetchProvider(ctx, { web }, provider)
  assertEq(registry.get(FETCH_PROVIDER_ID), provider, '注册进 seam 的 fetch 注册表')
  assertEq(typeof dispose, 'function', '返回注销函数')

  const replacement = createFetchProvider({})
  const disposeReplacement = attachFetchProvider(ctx, { web }, replacement)
  assertEq(registry.get(FETCH_PROVIDER_ID), replacement, 'HMR 重复注册：同 id 被新实例替换')
  assertTrue(ctx.logs.warn.some((line) => line.includes('替换旧注册')), '替换时留一条 warn')
  disposeReplacement()
  assertEq(registry.has(FETCH_PROVIDER_ID), false, '注销后从注册表摘掉')

  const locked = makeCtx({ registerFetchProvider() { throw Object.assign(new Error('boom'), { code: 'WEB_DUPLICATE_PROVIDER' }) } })
  assertEq(attachFetchProvider(locked, { web: locked.web }, createFetchProvider({})), null, '拿不到注册表时返回 null 而不抛')
  assertTrue(locked.logs.warn.some((line) => line.includes('无法替换')), '并告警保留旧实现')

  const broken = makeCtx({ registerFetchProvider() { throw new Error('boom') } })
  assertEq(attachFetchProvider(broken, { web: broken.web }, createFetchProvider({})), null, '未知注册异常降级为 null')
  assertTrue(broken.logs.warn.some((line) => line.includes('注册抓取提供方失败')), '未知异常也留一条 warn')
}

// --- 12. 插件入口接线：apply 会注册抓取提供方 --------------------------------
{
  const { apply, normalizeConfig } = await import('../lib/index.js')
  const fetchRegistry = new Map()
  const searchRegistry = new Map()
  const logs = { warn: [], info: [] }
  const ctx = {
    logger: { warn: (...args) => logs.warn.push(args.join(' ')), info: (...args) => logs.info.push(args.join(' ')) },
    on() {},
    effect(fn) {
      fn()
    },
    get() {
      return undefined
    },
    web: {
      config: { searchProvider: { get: () => 'opencode-go' }, fetchProvider: { get: () => FETCH_PROVIDER_ID } },
      searchProviders: searchRegistry,
      fetchProviders: fetchRegistry,
      registerSearchProvider(provider) {
        searchRegistry.set(provider.id, provider)
        return () => searchRegistry.delete(provider.id)
      },
      registerFetchProvider(provider) {
        fetchRegistry.set(provider.id, provider)
        return () => fetchRegistry.delete(provider.id)
      },
    },
  }
  apply(ctx, { patchFetch: false })
  assertEq(fetchRegistry.get(FETCH_PROVIDER_ID)?.id, FETCH_PROVIDER_ID, 'apply() 注册了抓取提供方')
  assertEq(searchRegistry.get('opencode-go')?.id, 'opencode-go', '搜索提供方照旧注册')
  assertEq(normalizeConfig({ fetch: { maxRedirects: 2 } }).fetch.maxRedirects, 2, 'normalizeConfig 合并 fetch 段')
  assertEq(normalizeConfig({}).fetch.provider, FETCH_PROVIDER_ID, 'fetch 段缺省时用本插件 id')
}

// --- 13. bundle patch 与提供方 id 的一致性（回归门禁）------------------------
{
  const bundlePatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assertTrue(bundlePatch.includes(`fetchProvider: ${FETCH_PROVIDER_ID}`), 'bundle patch 的 fetchProvider 指向本插件')
  assertTrue(bundlePatch.includes('searchProvider: opencode-go'), '搜索指向未被覆盖')
}

server.close()
crossServer.close()
console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
