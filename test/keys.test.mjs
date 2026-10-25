// Unit tests for the multi-key pool. Run: node test/keys.test.mjs

import { createKeyPool, isKeyFailureStatus, normalizeKeys } from '../lib/keys.js'

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

// --- normalizeKeys -----------------------------------------------------------
assertDeep(
  normalizeKeys(['a', { ref: 'b', priority: 2 }, { ref: ' a ' }, { ref: '' }, { ref: 'c', priority: '5' }]),
  [
    { ref: 'c', priority: 5 },
    { ref: 'b', priority: 2 },
    { ref: 'a', priority: 0 },
  ],
  '去重、排序、字符串 priority 归一',
)
assertDeep(normalizeKeys(undefined), [], '非数组返回空')
assertDeep(normalizeKeys([null, 3, {}, { ref: 1 }]), [], '无效条目被忽略')

// --- 优先级与会话粘滞 --------------------------------------------------------
const values = { high: 'v-high', low: 'v-low' }
const resolve = async (ref) => values[ref]
const anyValue = async (ref) => (typeof ref === 'string' && ref.length > 0 ? (values[ref] ?? `v-${ref}`) : undefined)
const pool = createKeyPool({
  keys: [
    { ref: 'high', priority: 10 },
    { ref: 'low', priority: 1 },
  ],
  resolve,
})
const first = await pool.pick('s1')
assertEq(first?.ref, 'high', '优先级高的先用')
assertEq(first?.value, 'v-high', '返回 key 值')
assertEq((await pool.pick('s1'))?.ref, 'high', '同一会话粘滞')
assertEq((await pool.pick('s2'))?.ref, 'high', '不同会话也优先高优先级')

// --- 连续失败阈值 ------------------------------------------------------------
let outcome = pool.record('s1', { status: 500 })
assertEq(outcome.rotated, false, '第一次 500 不换')
assertEq((await pool.pick('s1'))?.ref, 'high', '失败一次仍用原 key')
outcome = pool.record('s1', { status: 429 })
assertEq(outcome.rotated, true, '连续第二次失败换 key')
assertEq((await pool.pick('s1'))?.ref, 'low', '换到下一优先级')
assertEq(pool.record('s1', { status: 200 }).rotated, false, '成功后保持')
assertEq((await pool.pick('s1'))?.ref, 'low', '成功不改变粘滞')

// --- 401/403 立即换 ----------------------------------------------------------
const authPool = createKeyPool({
  keys: [
    { ref: 'a', priority: 10 },
    { ref: 'b', priority: 1 },
  ],
  resolve: anyValue,
})
assertEq((await authPool.pick('s'))?.ref, 'a', '先选 a')
assertEq(authPool.record('s', { status: 401 }).rotated, true, '401 立即换')
assertEq((await authPool.pick('s'))?.ref, 'b', '401 后选 b')

const quotaPool = createKeyPool({
  keys: [
    { ref: 'a', priority: 10 },
    { ref: 'b', priority: 1 },
  ],
  resolve: anyValue,
})
assertEq((await quotaPool.pick('q'))?.ref, 'a', '402 测试先选 a')
assertEq(quotaPool.record('q', { status: 402 }).rotated, true, '402 额度耗尽立即换')
assertEq((await quotaPool.pick('q'))?.ref, 'b', '402 后选 b')

// --- 同优先级随机 ------------------------------------------------------------
let seed = 0
const randomPool = createKeyPool({
  keys: [
    { ref: 'a', priority: 5 },
    { ref: 'b', priority: 5 },
    { ref: 'c', priority: 1 },
  ],
  resolve: anyValue,
  random: () => seed,
})
seed = 0
assertEq((await randomPool.pick('r1'))?.ref, 'a', '随机值 0 选同优先级第一个')
seed = 0.99
assertEq((await randomPool.pick('r2'))?.ref, 'b', '随机值 0.99 选同优先级最后一个')

// 同优先级失败后先换同组，再降级。
const groupPool = createKeyPool({
  keys: [
    { ref: 'a', priority: 10 },
    { ref: 'b', priority: 10 },
    { ref: 'c', priority: 1 },
  ],
  resolve: anyValue,
  random: () => 0,
})
assertEq((await groupPool.pick('g'))?.ref, 'a', '同组随机选 a')
assertEq(groupPool.record('g', { status: 401 }).rotated, true, 'a 失败立即换')
assertEq((await groupPool.pick('g'))?.ref, 'b', '先换同优先级的 b，不降到 c')
assertEq(groupPool.record('g', { status: 401 }).rotated, true, 'b 失败立即换')
assertEq((await groupPool.pick('g'))?.ref, 'c', '同组都用过才降到 c')

// --- 缺值跳过 ----------------------------------------------------------------
const missingPool = createKeyPool({
  keys: [
    { ref: 'missing', priority: 10 },
    { ref: 'ok', priority: 1 },
  ],
  resolve: async (ref) => (ref === 'ok' ? 'v-ok' : undefined),
})
assertEq((await missingPool.pick('m'))?.ref, 'ok', '没有值的 key 被跳过')

// --- 全部失败后重置 ----------------------------------------------------------
const resetPool = createKeyPool({ keys: [{ ref: 'only', priority: 1 }], resolve: anyValue })
assertEq((await resetPool.pick('x'))?.ref, 'only', '只有一个 key 时先选它')
assertEq(resetPool.record('x', { status: 401 }).rotated, true, '401 后标记失败')
assertEq((await resetPool.pick('x'))?.ref, 'only', '全部失败后重置，重新从最高优先级开始')

// --- 会话隔离 ----------------------------------------------------------------
const isolatePool = createKeyPool({
  keys: [
    { ref: 'a', priority: 10 },
    { ref: 'b', priority: 1 },
  ],
  resolve: anyValue,
})
assertEq((await isolatePool.pick('one'))?.ref, 'a', '会话 one 先选 a')
isolatePool.record('one', { status: 401 })
assertEq((await isolatePool.pick('one'))?.ref, 'b', '会话 one 换到 b')
assertEq((await isolatePool.pick('two'))?.ref, 'a', '会话 two 不受 one 影响')

// --- 并发选择共享同一次结果 --------------------------------------------------
const slowPool = createKeyPool({
  keys: [
    { ref: 'a', priority: 1 },
    { ref: 'b', priority: 1 },
  ],
  resolve: async (ref) => {
    await new Promise((done) => setTimeout(done, 5))
    return values[ref] ?? `v-${ref}`
  },
  random: () => 0,
})
const [concurrentA, concurrentB] = await Promise.all([slowPool.pick('c'), slowPool.pick('c')])
assertEq(concurrentA?.ref, concurrentB?.ref, '并发请求选中同一个 key')

// --- 迟到的旧请求失败不误伤新 key -------------------------------------------
const stalePool = createKeyPool({
  keys: [
    { ref: 'a', priority: 10 },
    { ref: 'b', priority: 1 },
  ],
  resolve: anyValue,
})
assertEq((await stalePool.pick('stale'))?.ref, 'a', '旧请求先选 a')
stalePool.record('stale', { ref: 'a', status: 401 })
assertEq((await stalePool.pick('stale'))?.ref, 'b', 'a 401 后换 b')
const staleOutcome = stalePool.record('stale', { ref: 'a', status: 500 })
assertEq(staleOutcome.ignored, true, '迟到的 a 失败被忽略')
assertEq((await stalePool.pick('stale'))?.ref, 'b', '忽略旧失败后仍用 b')

// --- 边界 --------------------------------------------------------------------
const trimPool = createKeyPool({
  keys: [{ ref: 'a', priority: 1 }],
  resolve: async () => '  secret-value  ',
})
assertEq((await trimPool.pick('t'))?.value, 'secret-value', 'key 值去掉首尾空白')

assertEq(isKeyFailureStatus(400), false, '400 不算 key 失败')
assertEq(isKeyFailureStatus(401), true, '401 算 key 失败')
assertEq(isKeyFailureStatus(402), true, '402 额度耗尽算 key 失败')
assertEq(isKeyFailureStatus(429), true, '429 算 key 失败')
assertEq(isKeyFailureStatus(503), true, '5xx 算 key 失败')
assertEq(isKeyFailureStatus(200), false, '200 不算 key 失败')

const emptyPool = createKeyPool({ keys: [] })
assertEq(await emptyPool.pick('s'), undefined, '未配置 keys 时不选 key')
assertEq(emptyPool.enabled, false, '未配置 keys 时 enabled=false')
assertEq(emptyPool.record('s', { status: 500 }).rotated, false, '未配置 keys 时 record 安全')

const defaultThreshold = createKeyPool({ keys: [{ ref: 'a' }], resolve })
assertEq(defaultThreshold.failoverAfter, 2, '默认连续失败阈值是 2')

console.log(`\n${stats.pass} passed, ${stats.fail} failed`)
