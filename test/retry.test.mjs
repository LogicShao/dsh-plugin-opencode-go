// Unit tests for the admission-429 retry policy. Run: node test/retry.test.mjs

import {
  RETRY_DEFAULTS,
  abortableSleep,
  createWaitBudget,
  isAdmissionRefusal,
  isReplayableBody,
  isReplayableRequest,
  normalizeRetryConfig,
  parseRetryHintMs,
  retryDelayMs,
} from '../lib/retry.js'

const stats = { pass: 0, fail: 0 }
function assertEq(actual, expected, label) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}
function assertDeep(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}
function assertTrue(value, label) {
  assertEq(Boolean(value), true, label)
}
function assertFalse(value, label) {
  assertEq(Boolean(value), false, label)
}
function assertRange(value, low, high, label) {
  const ok = typeof value === 'number' && value >= low && value <= high
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${value}, want ${low}..${high})`)
  ok ? stats.pass++ : stats.fail++
  if (!ok) process.exitCode = 1
}

/** 上游真实返回的错误体（session 日志里逐字出现过）。 */
const ADMISSION_BODY =
  '{"type":"server_error","message":"Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 3 s)"}'

// --- normalizeRetryConfig ----------------------------------------------------
const defaults = normalizeRetryConfig(undefined)
assertEq(defaults.enabled, true, '默认开启重试')
assertEq(defaults.maxAttempts, 2, '默认最多尝试 2 次（含首次）')
assertEq(defaults.honorServerHint, true, '默认尊重服务端提示')
assertEq(defaults.maxDelayMs, 30_000, '默认单次等待上限 30s')
assertDeep(defaults.statuses, [429], '默认只判断 429')
assertTrue(defaults !== RETRY_DEFAULTS && defaults.statuses !== RETRY_DEFAULTS.statuses, '返回独立对象，不改默认值')

const custom = normalizeRetryConfig({
  enabled: false,
  maxAttempts: 3.9,
  maxDelayMs: 12_000,
  initialDelayMs: 90_000,
  minDelayMs: 5_000,
  maxTotalWaitMs: 40_000,
  jitterRatio: 2,
  statuses: [429, 429, 503],
})
assertEq(custom.enabled, false, '布尔开关被采纳')
assertEq(custom.maxAttempts, 3, '次数向下取整')
assertEq(custom.minDelayMs, 5_000, 'minDelayMs 被采纳')
assertEq(custom.initialDelayMs, 12_000, 'initialDelayMs 被压到 maxDelayMs 以内')
assertEq(custom.jitterRatio, RETRY_DEFAULTS.jitterRatio, '越界抖动回落到默认')
assertDeep(custom.statuses, [429, 503], '状态码去重')

const ignored = normalizeRetryConfig({
  maxAttempts: -1,
  maxDelayMs: 'abc',
  minDelayMs: 0,
  jitterRatio: -1,
  statuses: [99, 400.5, 'x'],
})
assertEq(ignored.maxAttempts, RETRY_DEFAULTS.maxAttempts, '非法次数回落到默认')
assertEq(ignored.maxDelayMs, RETRY_DEFAULTS.maxDelayMs, '非数字上限回落到默认')
assertEq(ignored.minDelayMs, RETRY_DEFAULTS.minDelayMs, '0 忽略')
assertEq(ignored.jitterRatio, RETRY_DEFAULTS.jitterRatio, '负抖动回落到默认')
assertDeep(ignored.statuses, [429], '没有合法状态码时回落默认')

// --- isAdmissionRefusal ------------------------------------------------------
assertTrue(isAdmissionRefusal(429, ADMISSION_BODY), '识别 ttft_admission_refused')
assertTrue(
  isAdmissionRefusal(429, '{"type":"server_error","message":"[ttft_admission_refused] the cell is at capacity"}'),
  '识别其它提示语（无 after 提示）',
)
assertTrue(isAdmissionRefusal(429, 'Admission refused: at capacity; retry shortly', [429]), '识别 admission refused')
assertFalse(
  isAdmissionRefusal(429, '{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'),
  '配额 429 不重试',
)
assertFalse(
  isAdmissionRefusal(429, '{"type":"FreeUsageLimitError","message":"Monthly usage limit reached"}'),
  '免费额度 429 不重试',
)
assertFalse(isAdmissionRefusal(429, '{"type":"server_error","message":"billing problem"}'), '计费关键字不重试')
assertFalse(isAdmissionRefusal(429, '{"type":"server_error","message":"boom"}'), '无准入标记不重试')
assertFalse(isAdmissionRefusal(429, ''), '空正文不重试')
assertFalse(isAdmissionRefusal(500, ADMISSION_BODY), '500 不参与判定')
assertFalse(isAdmissionRefusal(429, ADMISSION_BODY, [503]), '状态码名单之外不重试')

// --- parseRetryHintMs --------------------------------------------------------
assertEq(parseRetryHintMs(new Headers(), ADMISSION_BODY), 3_000, '正文 after 3 s')
assertEq(
  parseRetryHintMs(new Headers(), '...retry shortly (after 19 s)'),
  19_000,
  '正文 after 19 s',
)
assertEq(parseRetryHintMs(new Headers(), 'please retry-after: 2.5 seconds'), 2_500, '正文 retry-after 秒')
assertEq(
  parseRetryHintMs(new Headers({ 'retry-after': '7' }), ''),
  7_000,
  '响应头 retry-after 秒',
)
assertEq(
  parseRetryHintMs(new Headers({ 'retry-after-ms': '850' }), ''),
  850,
  '响应头 retry-after-ms',
)
const future = new Date(Date.now() + 4_000).toUTCString()
assertRange(parseRetryHintMs(new Headers({ 'retry-after': future }), ''), 2_500, 4_000, '响应头 HTTP 日期')
assertEq(parseRetryHintMs(new Headers(), 'no hint here'), undefined, '没有提示返回 undefined')
assertEq(parseRetryHintMs(new Headers({ 'retry-after': '1800' }), ''), undefined, '超长提示被忽略')
assertEq(parseRetryHintMs(new Headers({ 'retry-after': '0' }), ''), undefined, '0 秒提示被忽略')
assertEq(parseRetryHintMs(new Headers({ 'retry-after': 'not-a-date' }), ''), undefined, '不可解析的头被忽略')
assertEq(parseRetryHintMs(new Headers(), 'retry after 900 s'), undefined, '超过 10 分钟的正文提示被忽略')
assertEq(parseRetryHintMs(undefined, ADMISSION_BODY), 3_000, '没有 Headers 也能从正文解析')

// --- retryDelayMs ------------------------------------------------------------
const base = normalizeRetryConfig({ maxAttempts: 3, maxDelayMs: 30_000, initialDelayMs: 2_000, minDelayMs: 1_000, jitterRatio: 0 })
assertEq(retryDelayMs({ attempt: 1, hintMs: 19_000, config: base, random: () => 0.5 }), 19_000, '提示优先于指数回退')
assertEq(retryDelayMs({ attempt: 1, config: base, random: () => 0 }), 2_000, '无提示时用 initialDelayMs')
assertEq(retryDelayMs({ attempt: 2, config: base, random: () => 0 }), 4_000, '无提示时指数回退')
assertEq(retryDelayMs({ attempt: 5, config: base, random: () => 0 }), 30_000, '指数回退不超过 maxDelayMs')
assertEq(retryDelayMs({ attempt: 1, hintMs: 60_000, config: base, random: () => 0 }), 30_000, '过长提示被夹到上限')
assertEq(retryDelayMs({ attempt: 1, hintMs: 200, config: base, random: () => 0 }), 1_000, '过短提示被夹到下限')
const jittered = normalizeRetryConfig({ ...base, jitterRatio: 0.5 })
assertRange(
  retryDelayMs({ attempt: 1, hintMs: 10_000, config: jittered, random: () => 1 }),
  15_000,
  15_000,
  '抖动只向上加',
)
assertRange(
  retryDelayMs({ attempt: 1, hintMs: 28_000, config: jittered, random: () => 1 }),
  28_000,
  30_000,
  '抖动后仍不超过 maxDelayMs',
)
assertEq(retryDelayMs({ attempt: 2, config: base, random: () => NaN }), 4_000, '非法随机数不影响结果')

// --- isReplayableBody / isReplayableRequest ---------------------------------
assertTrue(isReplayableBody(undefined) && isReplayableBody(null), '空 body 可重放')
assertTrue(isReplayableBody('{"model":"m"}'), '字符串 body 可重放')
assertTrue(isReplayableBody(new Uint8Array([1, 2, 3])), 'Uint8Array 可重放')
assertTrue(isReplayableBody(new ArrayBuffer(4)), 'ArrayBuffer 可重放')
assertTrue(isReplayableBody(new URLSearchParams({ a: '1' })), 'URLSearchParams 可重放')
assertTrue(isReplayableBody(new Blob(['x'])), 'Blob 可重放')
assertTrue(isReplayableBody(new DataView(new ArrayBuffer(4))), 'DataView 可重放')
assertFalse(isReplayableBody(new ReadableStream()), 'ReadableStream 不可重放')
assertFalse(isReplayableBody(new FormData()), 'FormData 不可重放（保守）')

assertTrue(isReplayableRequest('https://opencode.ai/zen/go/v1/messages', { body: '{}' }), '普通 url + 字符串 body 可重放')
assertTrue(isReplayableRequest('https://opencode.ai/x', undefined), '无 body 可重放')
assertFalse(
  isReplayableRequest('https://opencode.ai/x', { body: new ReadableStream(), duplex: 'half' }),
  '流式 body 不可重放',
)
assertFalse(isReplayableRequest('https://opencode.ai/x', { body: new ReadableStream() }), 'ReadableStream body 不可重放')
const requestWithBody = new Request('https://opencode.ai/x', { method: 'POST', body: 'hello' })
assertFalse(isReplayableRequest(requestWithBody, undefined), '带 body 的 Request 不可重放')
const requestWithoutBody = new Request('https://opencode.ai/x')
assertTrue(isReplayableRequest(requestWithoutBody, undefined), '无 body 的 Request 可重放')

// --- createWaitBudget --------------------------------------------------------
let clock = 1_000
const budget = createWaitBudget({ budgetMs: 10_000, windowMs: 60_000, limit: 2, now: () => clock })
assertEq(budget.take('s1', 6_000), true, '预算内允许等待')
assertEq(budget.take('s1', 5_000), false, '超出预算拒绝')
assertEq(budget.take('s2', 5_000), true, '不同会话独立记账')
assertEq(budget.snapshot(), 2, 'LRU 上限内')
assertEq(budget.take('s3', 1_000), true, '新会话仍可等待')
assertEq(budget.snapshot(), 2, '超过 LRU 上限淘汰最旧会话')
clock += 60_000
assertEq(budget.take('s3', 9_000), true, '窗口滚动后预算重置')
assertEq(budget.take('s1', 9_000), true, '被淘汰的会话重新开始')
assertEq(createWaitBudget({ budgetMs: 5_000, windowMs: 1_000, now: () => 0 }).take('x', 0), true, '0 等待直接允许')

// --- abortableSleep ----------------------------------------------------------
const started = Date.now()
await abortableSleep(5)
assertRange(Date.now() - started, 0, 1_000, '正常等待可返回')

const controller = new AbortController()
const wait = abortableSleep(5_000, controller.signal)
setTimeout(() => controller.abort(), 5)
let abortError
try {
  await wait
} catch (error) {
  abortError = error
}
assertEq(abortError?.name, 'AbortError', 'abort 时抛 AbortError')
assertRange(Date.now() - started, 0, 1_000, 'abort 立即结束等待')

let preAborted
try {
  await abortableSleep(1_000, AbortSignal.abort())
} catch (error) {
  preAborted = error
}
assertEq(preAborted?.name, 'AbortError', '已取消的 signal 立即拒绝')

console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
