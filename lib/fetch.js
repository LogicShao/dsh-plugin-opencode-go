// dsh-plugin-opencode-go — 抓取（web_fetch）提供方。
//
// DSH 内置的 web-fetch-http 在连接前自己解析域名，并要求整组 A/AAAA 答案都是
// 公网 unicast（`dsh-web-fetch-http` 的 network.js）。代理软件（Clash / mihomo /
// sing-box）的 fake-ip 会把域名解析到 198.18.0.0/15 或 fc00::/7，于是 web_fetch
// 直接报 `URL hostname "…" resolves to a non-public IP address`（WEB_BLOCKED_URL），
// 而同一台机器上的普通 fetch、浏览器却都能打开——因为路由器把假 IP 透明转发到了
// 真正的上游。
//
// 本模块注册一个不做「公网解析」校验的提供方：请求照常交给全局 fetch（由路由器/
// 本机代理的 TUN 接管），本地只保留三道检查——协议、URL 内嵌凭据、非公网 IP 字面量
// ——以及字节 / 字符 / 重定向 / 超时上限。HTML 由 dsh-tool-web 转 markdown，这里
// 只负责取回原文，并给出与内置提供方同形的 { url, statusCode, body, truncated }。
//
// 与内置实现的差异（有意为之）：
// - 域名不再要求解析到公网地址（fake-ip 场景的整个目的）；
// - IP 字面量按「非公网」拒绝，可用 `fetch.allowIpLiterals` 放开（测试/内网调试）；
// - 重定向逐跳校验但允许跨域（内置实现只跟同源），上限 `fetch.maxRedirects`。

import { BlockList, isIP } from 'node:net'

/** 提供方 id：bundle patch 的 `web.fetchProvider` 必须与它一致。 */
export const FETCH_PROVIDER_ID = 'opencode-go-fetch'

/** 默认 UA：表明是本插件，而不是伪装成浏览器。 */
export const DEFAULT_FETCH_USER_AGENT =
  'dsh-plugin-opencode-go/0.2.0 (+https://github.com/LogicShao/dsh-plugin-opencode-go)'

/** 抓取上限的默认值；与 dsh-web-fetch-http 的默认值保持一致，换过去行为不变。 */
export const FETCH_DEFAULTS = Object.freeze({
  provider: FETCH_PROVIDER_ID,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  allowIpLiterals: false,
  userAgent: DEFAULT_FETCH_USER_AGENT,
})

/** 带 web seam 错误码的抓取错误（普通 Error，按 `code` 路由即可）。 */
export class WebFetchError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WebFetchError'
    this.code = code
  }
}

/**
 * 非公网 / 特殊用途地址段：RFC 1918、环回、链路本地、CGNAT、基准测试段、
 * 组播、保留段，以及 IPv6 的 ULA、链路本地、NAT64、6to4、文档段。
 * `198.18.0.0/15` 正是 fake-ip 的默认段，所以它也必须在这里。
 */
const RESERVED = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  RESERVED.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  RESERVED.addSubnet(network, prefix, 'ipv6')
}

/**
 * 归一化抓取配置：只接受合法值，其余落回默认（写错字段不该让插件加载失败）。
 *
 * @param input 用户配置里的 `fetch` 段。
 * @returns 完整的抓取上限。
 */
export function normalizeFetchConfig(input) {
  const source = typeof input === 'object' && input !== null ? input : {}
  const merged = { ...FETCH_DEFAULTS }
  if (typeof source.provider === 'string' && source.provider.length > 0) merged.provider = source.provider
  if (typeof source.userAgent === 'string' && source.userAgent.length > 0) merged.userAgent = source.userAgent
  if (typeof source.allowIpLiterals === 'boolean') merged.allowIpLiterals = source.allowIpLiterals
  for (const key of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) merged[key] = Math.floor(value)
  }
  if (Number.isInteger(source.maxRedirects) && source.maxRedirects >= 0) merged.maxRedirects = source.maxRedirects
  return merged
}

/** 判断一个主机名是否是「非公网」IP 字面量（域名一律返回 false）。 */
export function isNonPublicLiteral(host) {
  const address = String(host).replace(/^\[/u, '').replace(/\]$/u, '')
  const family = isIP(address)
  if (family === 4) return RESERVED.check(address, 'ipv4')
  if (family === 6) {
    // IPv4-mapped IPv6（::ffff:127.0.0.1）按内嵌的 IPv4 判定。
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
    if (mapped !== null) return RESERVED.check(mapped[1], 'ipv4')
    try {
      return RESERVED.check(address, 'ipv6')
    } catch {
      return true
    }
  }
  return false
}

/**
 * 校验一个抓取目标：只允许 http(s)、不允许 URL 内嵌凭据、默认不允许非公网 IP 字面量。
 *
 * @param input 原始 URL 字符串或 URL 对象（重定向的每一跳都会过一遍）。
 * @param options.allowIpLiterals 为 true 时放行 IP 字面量（内网调试 / 测试用）。
 * @returns 解析后的 URL。
 */
export function assertAllowedTarget(input, options = {}) {
  let url
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input))
  } catch {
    throw new WebFetchError(`invalid URL: ${String(input)}`, 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebFetchError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  if (options.allowIpLiterals !== true && isNonPublicLiteral(url.hostname)) {
    throw new WebFetchError(
      `URL hostname "${url.hostname}" is a non-public IP literal; set fetch.allowIpLiterals to allow it`,
      'WEB_BLOCKED_URL',
    )
  }
  return url
}

/** 按 Content-Type 分类：html / text / undefined（不支持的类型）。 */
export function classifyContentType(contentType) {
  const mime = (contentType ?? '').replace(/;.*$/su, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) {
    return 'text'
  }
  return undefined
}

/** 取 `Content-Type` 里的 charset，小写；没有就返回 undefined。 */
export function parseCharset(contentType) {
  return /;\s*charset\s*=\s*"?([^";]+)"?/iu.exec(contentType ?? '')?.[1]?.trim().toLowerCase()
}

/** 当前 web seam 选择的是哪个抓取提供方（0.2.1 是 config accessor，0.2.0 是字段）。 */
export function configuredFetchProviderId(scope) {
  try {
    const accessor = scope?.web?.config?.fetchProvider
    if (typeof accessor === 'string') return accessor
    if (accessor !== undefined && accessor !== null && typeof accessor.get === 'function') return accessor.get()
    return scope?.web?.fetchProviderId
  } catch {
    return undefined
  }
}

/**
 * 造一个抓取提供方。它不做 DNS 解析校验：域名交给全局 fetch（及其代理）解析，
 * 本地只拦 IP 字面量，避免 `web_fetch http://192.168.1.1/` 打到内网。
 *
 * @param fetchConfig 用户配置里的 `fetch` 段（可省略）。
 * @param debug 可选调试回调，收到 `fetch` / `fetch-failed` 事件。
 */
export function createFetchProvider(fetchConfig = {}, debug = () => {}) {
  const limits = normalizeFetchConfig(fetchConfig)
  let webScope

  const provider = {
    id: limits.provider,
    /** attach 时由 attachFetchProvider 注入 web seam，供 available() 读取当前选择。 */
    bindScope(scope) {
      webScope = scope
    },
    // 只在自己被显式指到（或读不到选择）时可用：配置不再指向本插件时自动让路，
    // 避免两个可用提供方触发 WEB_PROVIDER_AMBIGUOUS。
    available() {
      const configured = configuredFetchProviderId(webScope)
      return configured === undefined || configured === provider.id
    },
    async fetch(request, signal) {
      const target = assertAllowedTarget(request?.url, limits)
      const deadline = AbortSignal.timeout(limits.timeoutMs)
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
      try {
        const { response, finalUrl } = await requestFollowingRedirects(target, limits, combined)
        const result = await readResponseBody(response, finalUrl, limits)
        debug({
          event: 'fetch',
          url: result.url,
          status: result.statusCode,
          kind: result.body.kind,
          chars: result.body.content.length,
          truncated: result.truncated,
        })
        return result
      } catch (error) {
        const translated = translateFetchError(error, signal, deadline)
        debug({ event: 'fetch-failed', url: target.href, code: translated.code, message: translated.message })
        throw translated
      }
    },
  }

  return provider
}

/** 抓取失败的错误归一：本地校验错误原样抛，超时/取消/网络错误翻译成 seam 词汇。 */
function translateFetchError(error, signal, deadline) {
  if (error instanceof WebFetchError) return error
  if (deadline.aborted === true) return new WebFetchError('web fetch timed out', 'WEB_FETCH_TIMEOUT')
  if (signal?.aborted === true) return new WebFetchError('web fetch aborted', 'WEB_ABORTED')
  const detail = error instanceof Error ? error.message : String(error)
  return new WebFetchError(`web fetch failed: ${detail}`, 'WEB_PROVIDER_ERROR')
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * 手动跟重定向：每一跳都重新过 `assertAllowedTarget`，所以「只在入口拦字面量、
 * 302 到内网」这种绕过不成立。跟随上限由 `fetch.maxRedirects` 控制。
 */
async function requestFollowingRedirects(start, limits, signal) {
  let current = start
  for (let hops = 0; ; hops += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': limits.userAgent,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      },
      signal,
    })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current }

    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null) {
      throw new WebFetchError(
        `redirect response (HTTP ${response.status}) without a Location header`,
        'WEB_PROVIDER_ERROR',
      )
    }
    if (hops >= limits.maxRedirects) {
      throw new WebFetchError(`exceeded the maximum of ${limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
    }
    let next
    try {
      next = new URL(location, current)
    } catch {
      throw new WebFetchError(`invalid redirect location "${location}"`, 'WEB_BLOCKED_URL')
    }
    current = assertAllowedTarget(next, limits)
  }
}

/** 读取响应体：类型白名单 → Content-Length 预检 → 按字节截断 → 按字符截断。 */
async function readResponseBody(response, finalUrl, limits) {
  const contentType = response.headers.get('content-type')
  const kind = classifyContentType(contentType)
  if (kind === undefined) {
    await response.body?.cancel()
    throw new WebFetchError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
    await response.body?.cancel()
    throw new WebFetchError(`response exceeds the maximum of ${limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
  }

  const { bytes, truncatedByBytes } = await readCappedBytes(response, limits.maxResponseBytes)
  const decoded = decoderForCharset(parseCharset(contentType)).decode(bytes)
  const truncatedByChars = decoded.length > limits.maxBodyChars
  return {
    url: finalUrl.toString(),
    statusCode: response.status,
    body: { kind, content: truncatedByChars ? decoded.slice(0, limits.maxBodyChars) : decoded },
    truncated: truncatedByBytes || truncatedByChars,
  }
}

/** 按字节上限读流；超出就截断并取消剩余流（与内置提供方一致：截断而非报错）。 */
async function readCappedBytes(response, maxBytes) {
  if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let truncatedByBytes = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const room = maxBytes - total
    if (value.byteLength > room) {
      if (room > 0) {
        chunks.push(value.subarray(0, room))
        total += room
      }
      truncatedByBytes = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncatedByBytes }
}

/** 声明式 charset 优先，缺省 UTF-8；不可识别的标签按不支持的类型报错，不吐乱码。 */
function decoderForCharset(charset) {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch {
    throw new WebFetchError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  }
}

/**
 * 把提供方挂到 web seam（与 index.js 里的搜索提供方同一套重复注册处理）。
 *
 * DSH 0.2 的 `registerFetchProvider` 用 **web 服务**的 fiber 记账：插件热重载时
 * 旧注册不会自动释放，再注册会抛 `WEB_DUPLICATE_PROVIDER`。这里先摘掉同 id 的旧
 * 条目再挂新的；摘不掉就告警保留旧实现（重启后生效）。
 *
 * @returns 注销本次注册的函数（`null` 表示没挂上）。
 */
export function attachFetchProvider(ctx, scope, provider) {
  const disposer = (value) => (typeof value === 'function' ? value : () => {})
  provider.bindScope?.(scope)
  try {
    return disposer(scope.web.registerFetchProvider(provider))
  } catch (error) {
    if (error?.code !== 'WEB_DUPLICATE_PROVIDER') {
      ctx.logger?.warn(`opencode-go: 注册抓取提供方失败：${String(error?.message ?? error)}`)
      return null
    }
    const registry = scope.web.fetchProviders
    if (!(registry instanceof Map) || !registry.delete(provider.id)) {
      ctx.logger?.warn(
        `opencode-go: 抓取提供方 "${String(provider.id)}" 已被占用且无法替换，保留旧实现；重启 DSH 后新配置生效`,
      )
      return null
    }
    try {
      const replaced = disposer(scope.web.registerFetchProvider(provider))
      ctx.logger?.warn(`opencode-go: 抓取提供方 "${String(provider.id)}" 已存在，已用本次配置替换旧注册`)
      return replaced
    } catch (second) {
      ctx.logger?.warn(`opencode-go: 替换抓取提供方失败：${String(second?.message ?? second)}`)
      return null
    }
  }
}
