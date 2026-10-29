// dsh-plugin-opencode-go — 容量/准入类 429 的重试策略。
//
// Go 网关在 serving cell 满载时会返回 429（Anthropic 风格的错误体）：
//
//   {"type":"server_error","message":"Upstream request failed: [ttft_admission_refused]
//    the cell is at capacity; retry shortly (after 3 s)"}
//
// 这是「等一会儿再来」的准入拒绝，不是配额或凭据问题。DSH 自带的 llm-retry 虽然会把
// 它归为 RATE_LIMIT 并重试，但 backoff 只有 0.5s→8s，通常早于服务端提示（3/19/25s）
// 就再次敲门，于是仍然被拒。本模块只负责判断与计算：哪些 429 值得重试、服务端要求等
// 多久、一次请求累计最多等多久、会话级预算还剩多少。真正发起第二次请求的循环在
// index.js 的 fetch 包装里。
//
// 不做的事：不解析 SSE 流内错误（HTTP 200 之后到达的 error 事件在 fetch 层不可重放），
// 不重试配额类 429（GoUsageLimitError / FreeUsageLimitError / 余额不足等）。

/** 重试默认值。`maxAttempts` 含首次请求；`budgetMs` 是按会话的滚动等待预算。 */
export const RETRY_DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 2,
  honorServerHint: true,
  initialDelayMs: 2_000,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxTotalWaitMs: 45_000,
  jitterRatio: 0.15,
  budgetMs: 120_000,
  budgetWindowMs: 600_000,
  statuses: Object.freeze([429]),
})

/** 服务端提示最多认到 10 分钟；更大的数字基本是正文里的无关文本。 */
const MAX_HINT_MS = 600_000

/** 配额/计费类 429：重试没有意义，必须原样交给上层。 */
const QUOTA_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage limit|quota|billing|available balance|insufficient_quota/i

/**
 * 准入拒绝的正文标记。要求命中至少一条，且不能命中配额关键字——两者都会出现在
 * 429 里，混为一谈会把「额度用完」误判成「暂时没容量」，然后白等 30 秒。
 */
const ADMISSION_PATTERNS = [
  /ttft_admission_refused/i,
  /admission refused/i,
  /cell is at capacity/i,
  /at capacity.{0,40}retry/i,
]

/** 只接受 HTTP 状态码；非法值回落到默认的 [429]。 */
function normalizeStatuses(value) {
  if (!Array.isArray(value)) return [...RETRY_DEFAULTS.statuses]
  const statuses = [...new Set(value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 100 && entry <= 599))]
  return statuses.length > 0 ? statuses : [...RETRY_DEFAULTS.statuses]
}

/**
 * 归一化 `config.retry`：合法值才收，写错不拖垮插件加载。
 *
 * @param input 用户配置里的 `retry` 段（可省略）。
 * @returns 完整的重试配置（statuses 是拷贝）。
 */
export function normalizeRetryConfig(input) {
  const source = typeof input === 'object' && input !== null ? input : {}
  const merged = { ...RETRY_DEFAULTS, statuses: [...RETRY_DEFAULTS.statuses] }
  if (typeof source.enabled === 'boolean') merged.enabled = source.enabled
  if (typeof source.honorServerHint === 'boolean') merged.honorServerHint = source.honorServerHint
  for (const key of [
    'maxAttempts',
    'initialDelayMs',
    'minDelayMs',
    'maxDelayMs',
    'maxTotalWaitMs',
    'budgetMs',
    'budgetWindowMs',
  ]) {
    const value = Number(source[key])
    if (Number.isFinite(value) && value > 0) merged[key] = Math.floor(value)
  }
  if (merged.maxAttempts < 1) merged.maxAttempts = 1
  if (merged.minDelayMs > merged.maxDelayMs) merged.minDelayMs = merged.maxDelayMs
  if (merged.initialDelayMs > merged.maxDelayMs) merged.initialDelayMs = merged.maxDelayMs
  const jitter = Number(source.jitterRatio)
  if (Number.isFinite(jitter) && jitter >= 0 && jitter <= 1) merged.jitterRatio = jitter
  merged.statuses = normalizeStatuses(source.statuses)
  return merged
}

/**
 * 这是不是「容量/准入」类失败：状态码在名单里，正文命中准入标记，
 * 且不是配额/计费错误。
 *
 * @param status HTTP 状态码。
 * @param text 已读取的响应正文（可为 undefined）。
 * @param statuses 参与判定的状态码（默认 [429]）。
 * @returns 是否值得按服务端提示重试。
 */
export function isAdmissionRefusal(status, text, statuses = RETRY_DEFAULTS.statuses) {
  if (!Array.isArray(statuses) || !statuses.includes(Number(status))) return false
  const body = typeof text === 'string' ? text : ''
  if (body.length === 0) return false
  if (QUOTA_PATTERN.test(body)) return false
  return ADMISSION_PATTERNS.some((pattern) => pattern.test(body))
}

/** 从 Headers / 类似对象里取一个头，取不到（或对象不支持 get）返回 undefined。 */
function headerValue(headers, name) {
  try {
    const value = headers?.get?.(name)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** 提示值合法性：非有限、非正、或大到离谱都视为没有提示。 */
function boundHint(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_HINT_MS) return undefined
  return ms
}

/** 从错误正文里找「retry ... after N s / retry-after: N」；找不到返回 undefined。 */
function parseBodyHint(body) {
  if (body.length === 0) return undefined
  const patterns = [
    /retry[^()]{0,24}\(?\s*after\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:onds?)?\b)/i,
    /retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:onds?)?\b)?/i,
    /\bafter\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:onds?)?\b)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match === null) continue
    const seconds = Number(match[1])
    const hint = boundHint(seconds * 1000)
    if (hint !== undefined) return hint
  }
  return undefined
}

/**
 * 解析服务端要求等待多久：正文提示优先，其次 `retry-after-ms` / `retry-after`。
 *
 * @param headers 响应的 Headers（或带 get 的类似对象）。
 * @param text 响应正文（可为 undefined）。
 * @returns 毫秒数；没有可用提示返回 undefined。
 */
export function parseRetryHintMs(headers, text) {
  const fromBody = parseBodyHint(typeof text === 'string' ? text : '')
  if (fromBody !== undefined) return fromBody

  const milliseconds = Number.parseFloat(headerValue(headers, 'retry-after-ms'))
  if (Number.isFinite(milliseconds)) {
    const hint = boundHint(milliseconds)
    if (hint !== undefined) return hint
  }

  const retryAfter = headerValue(headers, 'retry-after')
  if (retryAfter !== undefined) {
    const seconds = Number.parseFloat(retryAfter)
    if (Number.isFinite(seconds)) {
      const hint = boundHint(seconds * 1000)
      if (hint !== undefined) return hint
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return boundHint(date - Date.now())
  }
  return undefined
}

/**
 * 计算第 `attempt` 次重试前该等多久。
 *
 * - 有服务端提示就用提示值（服务端更清楚 cell 何时腾出容量），否则指数回退；
 * - 夹在 [minDelayMs, maxDelayMs]；
 * - 抖动只向上加，宁可晚一点，不要比服务端要求更早；
 * - 结果不超过 maxDelayMs。
 *
 * @param attempt 第几次重试（1 起）。
 * @param hintMs 服务端提示（毫秒），可为 undefined。
 * @param config 归一化后的重试配置。
 * @param random 0..1 随机源（测试可注入）。
 * @returns 毫秒数（整数）。
 */
export function retryDelayMs({ attempt, hintMs, config = RETRY_DEFAULTS, random = Math.random } = {}) {
  const step = Math.max(1, Math.trunc(Number(attempt) || 1))
  const base =
    typeof hintMs === 'number' && Number.isFinite(hintMs) && hintMs > 0
      ? hintMs
      : config.initialDelayMs * 2 ** (step - 1)
  const bounded = Math.min(Math.max(base, config.minDelayMs), config.maxDelayMs)
  const roll = Number(random())
  const jittered = bounded * (1 + config.jitterRatio * (Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1) : 0))
  return Math.round(Math.min(jittered, config.maxDelayMs))
}

/**
 * 请求体能否在第二次请求里原样重发。字符串 / 字节 / Blob 这类可以；
 * ReadableStream 已经被读过就没了，重发会发出空 body，所以一律不重试。
 */
export function isReplayableBody(body) {
  if (body === undefined || body === null) return true
  if (typeof body === 'string') return true
  if (body instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(body)) return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  return false
}

/**
 * 这次 fetch 调用能否安全重发：流式 body、带 body 的 Request（未显式给 init.body）
 * 都不行，因为第一次请求已经消费了它。
 */
export function isReplayableRequest(input, init) {
  if (init?.duplex === 'half') return false
  if (init?.body !== undefined) return isReplayableBody(init.body)
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
  if (request === undefined) return true
  return request.body === null || request.body === undefined
}

/**
 * 会话级滚动等待预算：同一会话在一个窗口内累计等待超过 `budgetMs` 后，后续 fetch
 * 不再在插件层等待，交给上层（DSH 的 llm-retry）快速失败。没有这层，插件重试和外层
 * 5 次重试会相乘，最长可能卡好几分钟。
 *
 * @param budgetMs 窗口内允许等待的总毫秒数。
 * @param windowMs 窗口长度（毫秒）。
 * @param limit 最多记住多少个会话（LRU）。
 * @param now 时钟（测试可注入）。
 */
export function createWaitBudget({ budgetMs, windowMs, limit = 256, now = Date.now } = {}) {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : RETRY_DEFAULTS.budgetMs
  const windowLength = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : RETRY_DEFAULTS.budgetWindowMs
  const maxEntries = Number.isInteger(limit) && limit > 0 ? limit : 256
  const entries = new Map()

  function stateFor(sessionId) {
    const id = String(sessionId ?? '')
    const existing = entries.get(id)
    if (existing !== undefined) {
      // 访问即刷新 LRU 顺序。
      entries.delete(id)
      entries.set(id, existing)
      return existing
    }
    const created = { start: now(), spent: 0 }
    entries.set(id, created)
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
    }
    return created
  }

  /** 申请 `delayMs` 的预算；允许则记账并返回 true，超出返回 false。 */
  function take(sessionId, delayMs) {
    const amount = Number(delayMs)
    if (!Number.isFinite(amount) || amount <= 0) return true
    const state = stateFor(sessionId)
    const current = now()
    if (current - state.start >= windowLength) {
      state.start = current
      state.spent = 0
    }
    if (state.spent + amount > budget) return false
    state.spent += amount
    return true
  }

  return {
    take,
    budgetMs: budget,
    windowMs: windowLength,
    /** 仅用于测试/调试：当前记住的会话数。 */
    snapshot: () => entries.size,
  }
}

/** 造一个可被 AbortSignal 打断的等待；取消时抛 AbortError，且不会泄漏定时器。 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(abortError(signal))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** AbortSignal 的 reason 不一定是 Error（可能是任意值），转成 AbortError 再抛。 */
function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}
