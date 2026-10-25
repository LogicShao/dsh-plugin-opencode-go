// 多 key 池：按优先级选择、按会话粘滞、失败后切换。
//
// 规则：
// - priority 高的先用；同一优先级随机选一个；
// - 同一个 session（对话）固定用同一个 key，直到它连续失败；
// - 401/402/403 立即换 key；408/429/5xx/网络错误连续 keyFailoverAfter 次后换；
// - 所有 key 都失败过一轮后清空失败记录，重新从最高优先级开始。
//
// 本模块不保存密钥内容：调用方注入 `resolve(ref) -> Promise<string|undefined>`，
// ref 一般是 ~/.dsh/.credentials.yaml 里的引用名，或启动环境变量名。

export const DEFAULT_FAILOVER_AFTER = 2
const DEFAULT_SESSION_LIMIT = 512

/** 归一化配置：字符串或 { ref, priority } → 去重、按 priority 降序。 */
export function normalizeKeys(value) {
  if (!Array.isArray(value)) return []
  const byRef = new Map()
  for (const raw of value) {
    const entry = typeof raw === 'string' ? { ref: raw } : raw
    if (entry === null || typeof entry !== 'object') continue
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : ''
    if (ref.length === 0) continue
    const priorityNumber = Number(entry.priority)
    const priority = Number.isFinite(priorityNumber) ? Math.trunc(priorityNumber) : 0
    const previous = byRef.get(ref)
    if (previous === undefined || priority > previous.priority) byRef.set(ref, { ref, priority })
  }
  return [...byRef.values()].sort((left, right) => right.priority - left.priority)
}

/** 这些 HTTP 状态码说明 key 本身可能有问题（或上游暂时不可用）。 */
export function isKeyFailureStatus(status) {
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)
}

/** 401/402/403 是凭据/额度问题，立即换；其余失败连续累计后换。 */
function outcomeKind(status) {
  if (!isKeyFailureStatus(status)) return 'ok'
  if (status === 401 || status === 402 || status === 403) return 'auth'
  return 'retryable'
}

/** 密钥值只保留可放进 HTTP 头的字符串；空白/非字符串视为不可用。 */
function keyValue(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

export function createKeyPool({
  keys,
  failoverAfter = DEFAULT_FAILOVER_AFTER,
  resolve,
  random = Math.random,
  logger,
  sessionLimit = DEFAULT_SESSION_LIMIT,
} = {}) {
  const entries = normalizeKeys(keys)
  const after = Number.isInteger(failoverAfter) && failoverAfter > 0 ? failoverAfter : DEFAULT_FAILOVER_AFTER
  const resolveKey = typeof resolve === 'function' ? resolve : async (ref) => process.env[ref]
  const rand = typeof random === 'function' ? random : Math.random
  const maxSessions = Number.isInteger(sessionLimit) && sessionLimit > 0 ? sessionLimit : DEFAULT_SESSION_LIMIT
  const sessions = new Map()

  const warn = (message) => {
    try {
      logger?.warn?.(`opencode-go: ${message}`)
    } catch {
      /* 日志失败不影响请求 */
    }
  }

  function stateFor(sessionId) {
    const id = String(sessionId ?? '')
    const existing = sessions.get(id)
    if (existing !== undefined) {
      // 访问即刷新 LRU 顺序。
      sessions.delete(id)
      sessions.set(id, existing)
      return existing
    }
    const state = { current: undefined, priority: undefined, failures: 0, exhausted: new Set(), pending: undefined }
    sessions.set(id, state)
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    return state
  }

  async function selectFor(state) {
    if (state.current !== undefined) {
      const value = keyValue(await resolveKey(state.current))
      if (value !== undefined) {
        return { ref: state.current, priority: state.priority, value, failures: state.failures }
      }
      const stale = state.current
      state.exhausted.add(stale)
      state.current = undefined
      state.priority = undefined
      warn(`key "${stale}" 不可用，换下一个`)
    }

    for (let guard = 0; guard <= entries.length; guard += 1) {
      let candidates = entries.filter((entry) => !state.exhausted.has(entry.ref))
      if (candidates.length === 0) {
        warn('所有 key 都失败过一轮，重新从最高优先级开始')
        state.exhausted.clear()
        state.failures = 0
        candidates = entries.slice()
      }
      const top = candidates.reduce((max, entry) => Math.max(max, entry.priority), Number.NEGATIVE_INFINITY)
      const group = candidates.filter((entry) => entry.priority === top)
      const entry = group[Math.min(group.length - 1, Math.floor(rand() * group.length))]
      const value = keyValue(await resolveKey(entry.ref))
      if (value === undefined) {
        state.exhausted.add(entry.ref)
        warn(`key "${entry.ref}" 没有配置值，跳过`)
        continue
      }
      state.current = entry.ref
      state.priority = entry.priority
      state.failures = 0
      return { ref: entry.ref, priority: entry.priority, value, failures: 0 }
    }
    return undefined
  }

  /** 选当前 session 该用的 key；并发调用共享同一次选择。 */
  async function pick(sessionId) {
    if (entries.length === 0) return undefined
    const state = stateFor(sessionId)
    if (state.pending !== undefined) return state.pending
    state.pending = (async () => {
      try {
        return await selectFor(state)
      } finally {
        state.pending = undefined
      }
    })()
    return state.pending
  }

  function failCurrent(state, kind) {
    const ref = state.current
    if (ref === undefined) return { rotated: false }
    state.failures += 1
    const threshold = kind === 'auth' ? 1 : after
    if (state.failures < threshold) return { rotated: false, ref, failures: state.failures }
    state.exhausted.add(ref)
    state.current = undefined
    state.priority = undefined
    state.failures = 0
    warn(`key "${ref}" 连续失败 ${String(threshold)} 次，当前会话换 key`)
    return { rotated: true, ref }
  }

  /**
   * 记录一次请求结果。`status` 是 HTTP 状态码；网络错误传 `{ networkError: true }`。
   * 取消（AbortError）不应调用这里。
   */
  function record(sessionId, outcome = {}) {
    const state = sessions.get(String(sessionId ?? ''))
    if (state === undefined || state.current === undefined) return { rotated: false }
    // 并发请求可能已经把 key 换掉；迟到的旧请求失败不能算到新 key 头上。
    if (outcome.ref !== undefined && outcome.ref !== state.current) {
      return { rotated: false, ref: state.current, ignored: true }
    }
    if (outcome.networkError === true) return failCurrent(state, 'retryable')
    if (!Number.isInteger(outcome.status)) return { rotated: false, ref: state.current }
    const kind = outcomeKind(outcome.status)
    if (kind === 'ok') {
      state.failures = 0
      return { rotated: false, ref: state.current }
    }
    return failCurrent(state, kind)
  }

  function reset(sessionId) {
    sessions.delete(String(sessionId ?? ''))
  }

  return {
    entries,
    enabled: entries.length > 0,
    failoverAfter: after,
    pick,
    record,
    reset,
    /** 仅用于测试/调试，不包含 key 值。 */
    snapshot() {
      return {
        entries: entries.map((entry) => ({ ref: entry.ref, priority: entry.priority })),
        sessions: sessions.size,
      }
    },
  }
}
