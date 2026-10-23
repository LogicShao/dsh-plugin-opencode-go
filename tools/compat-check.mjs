#!/usr/bin/env node
// 升级 DSH 后的兼容性自检。
//
// 本插件只依赖四处宿主契约：`ctx.inject` / `ctx.effect`、`llm/stream` 瀑布与
// `options.{provider,model,sessionId}`、`ctx.web.registerSearchProvider(provider)` 的
// provider 形状、`ctx.credentials.resolve(ref)` 与 `agents.currentInitiator()` 两个服务。
// 这个脚本不进 DSH 进程，只读安装包（app.asar）或解包目录里的源码，逐条核对符号是否还在，
// 顺手报出各包版本，升级后先跑它再决定要不要改插件。
//
// 用法：
//   node tools/compat-check.mjs                # 自动找常见安装位置
//   node tools/compat-check.mjs <app.asar>     # 指定安装包
//   node tools/compat-check.mjs <解包目录>      # 指定含 node_modules/@deepseek-ai 的目录
//   DSH_APP_ASAR=... node tools/compat-check.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = [
  process.env.DSH_APP_ASAR,
  'D:\\software\\ai\\dsh\\resources\\app.asar',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  join(process.cwd(), 'resources', 'app.asar'),
].filter((value) => typeof value === 'string' && value.length > 0)

/** 摊平 asar 头表：posix 相对路径 → 读取器。 */
function openAsar(file) {
  const buffer = readFileSync(file)
  const headerSize = buffer.readUInt32LE(4)
  const jsonLen = buffer.readUInt32LE(12)
  const base = 8 + headerSize
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLen).toString('utf8'))
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}${name}`
      if (child.files) walk(child, `${path}/`)
      else files.set(path, { offset: Number(child.offset), size: Number(child.size) })
    }
  }
  walk(header, '')
  return {
    kind: `asar ${file}`,
    paths: () => [...files.keys()],
    read: (path) => {
      const entry = files.get(path)
      return entry === undefined ? undefined : buffer.subarray(base + entry.offset, base + entry.offset + entry.size).toString('utf8')
    },
    exists: (path) => files.has(path),
  }
}

/** 摊平目录：posix 相对路径 → 读取器。 */
function openDir(root) {
  const files = new Map()
  const limit = 80_000
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (files.size > limit) return
      const abs = join(dir, name)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        if (name === '.git' || name === '.pnpm' || name.startsWith('.')) continue
        walk(abs)
      } else {
        files.set(abs.slice(root.length + 1).replaceAll('\\', '/'), { abs, size: stat.size })
      }
    }
  }
  walk(root)
  return {
    kind: `dir ${root}`,
    paths: () => [...files.keys()],
    read: (path) => {
      const entry = files.get(path)
      return entry === undefined ? undefined : readFileSync(entry.abs, 'utf8')
    },
    exists: (path) => files.has(path),
  }
}

function openSource(target) {
  if (!existsSync(target)) return undefined
  return statSync(target).isDirectory() ? openDir(target) : openAsar(target)
}

/** 在摊平的路径里按 `node_modules/<pkg>/<suffix>` 找到真实路径。 */
function locate(source, pkg, suffix) {
  const needle = `node_modules/@deepseek-ai/${pkg}/${suffix}`
  const paths = source.paths()
  return paths.find((path) => path.endsWith(needle) && !path.includes('.pnpm')) ?? paths.find((path) => path.endsWith(needle))
}

function packageVersion(source, pkg) {
  const path = locate(source, pkg, 'package.json')
  if (path === undefined) return undefined
  try {
    return JSON.parse(source.read(path))?.version
  } catch {
    return undefined
  }
}

/** 宿主契约清单：每项都是插件真的用到的符号。 */
const CONTRACTS = [
  { area: 'cordis', what: 'ctx.inject(deps, cb)', pkg: 'cordis', file: 'lib/index.js', test: /inject\(inject, callback\)/ },
  { area: 'cordis', what: 'ctx.effect(fn, label)', pkg: 'cordis', file: 'lib/index.js', test: /effect\(execute, label/ },
  { area: 'llm', what: 'llm/stream 瀑布', pkg: 'dsh-llm', file: 'lib/index.js', test: /"llm\/stream"/ },
  { area: 'llm', what: 'GenerateOptions 含 sessionId', pkg: 'dsh-llm', file: 'lib/typert.host.js', test: /sessionId\?:/ },
  { area: 'llm', what: 'GenerateOptions 含 provider/model', pkg: 'dsh-llm', file: 'lib/typert.host.js', test: /provider: string;[\s\S]{0,80}model: string;/ },
  { area: 'agents', what: 'agents.currentInitiator()', pkg: 'dsh-agent', file: 'lib/index.js', test: /currentInitiator\(\)/ },
  { area: 'agents', what: 'session.id', pkg: 'dsh-agent', file: 'lib/index.js', test: /session\.id/ },
  { area: 'credentials', what: 'credentials.resolve(ref)', pkg: 'dsh-credentials-local', file: 'lib/index.js', test: /resolve\(ref\)/ },
  { area: 'web', what: 'web.registerSearchProvider()', pkg: 'dsh-web', file: 'lib/index.js', test: /registerSearchProvider\(provider\)/ },
  { area: 'web', what: 'web.registerFetchProvider()', pkg: 'dsh-web', file: 'lib/index.js', test: /registerFetchProvider\(provider\)/ },
  { area: 'web', what: 'web 配置字段 searchProvider', pkg: 'dsh-web', file: 'lib/index.js', test: /searchProvider:\s*z\.string\(\)/ },
  { area: 'web', what: 'web 配置字段 fetchProvider', pkg: 'dsh-web', file: 'lib/index.js', test: /fetchProvider:\s*z\.string\(\)/ },
  { area: 'web', what: 'provider.available()', pkg: 'dsh-web', file: 'lib/index.js', test: /\.available\(\)/ },
  { area: 'web', what: '重复 id → WEB_DUPLICATE_PROVIDER', pkg: 'dsh-web', file: 'lib/index.js', test: /WEB_DUPLICATE_PROVIDER/ },
  { area: 'web', what: 'seam 截断 → truncated:true', pkg: 'dsh-web', file: 'lib/index.js', test: /truncated: true/ },
  { area: 'web', what: 'seam 注册表字段 searchProviders', pkg: 'dsh-web', file: 'lib/index.js', test: /searchProviders = \/\* @__PURE__ \*\/ new Map/ },
  { area: 'web', what: 'seam 注册表字段 fetchProviders', pkg: 'dsh-web', file: 'lib/index.js', test: /fetchProviders = \/\* @__PURE__ \*\/ new Map/ },
  { area: 'web', what: 'fetch 结果形状（tool-web 消费 body.kind/content）', pkg: 'dsh-tool-web', file: 'lib/index.js', test: /kind: result\.body\.kind[\s\S]{0,80}content: result\.body\.content/ },
  { area: 'tool', what: 'web_search 超时 searchTimeoutMs', pkg: 'dsh-tool-web', file: 'lib/index.js', test: /searchTimeoutMs/ },
  { area: 'settings', what: 'schema 投影 volatileForm（Config 字段描述符）', pkg: 'dsh-settings', file: 'lib/types/schema.js', test: /export function volatileForm/ },
  { area: 'settings', what: '表单按插件行 id 命名空间', pkg: 'dsh-settings', file: 'lib/index.js', test: /ns: entry\.options\.id/ },
  { area: 'llm', what: '容量唯一出口 normalizeModelInfo', pkg: 'dsh-llm', file: 'lib/index.js', test: /normalizeModelInfo\(registration, model, resolved\)/ },
  { area: 'llm', what: 'defaultMaxTokens 落成请求 maxTokens', pkg: 'dsh-llm', file: 'lib/index.js', test: /maxTokens: info\.defaultMaxTokens/ },
  { area: 'compaction', what: '压缩阈值由 resolveCompactSpec 计算', pkg: 'dsh-compaction-basic', file: 'lib/index.js', test: /function resolveCompactSpec/ },
  { area: 'schemastery', what: 'volatile() 修饰符', pkg: 'schemastery', file: 'lib/index.mjs', test: /prototype\.volatile = function/ },
]

const VERSION_PACKAGES = [
  'dsh',
  'dsh-web',
  'dsh-llm',
  'dsh-agent',
  'dsh-credentials-local',
  'cordis',
  'dsh-tool-web',
  'dsh-settings',
  'dsh-compaction-basic',
  'dsh-client-modules',
  'dsh-client-ui-plugin-manager',
  'dsh-client-ui-settings',
  'schemastery',
]

const target = process.argv[2] ?? CANDIDATES.find((path) => existsSync(path))
if (target === undefined) {
  console.error('找不到 DSH 安装包；请把 app.asar 或解包目录作为参数传入。')
  process.exit(2)
}
const source = openSource(target)
if (source === undefined) {
  console.error(`打不开目标：${target}`)
  process.exit(2)
}

console.log(`检查目标：${source.kind}\n`)

console.log('包版本：')
for (const pkg of VERSION_PACKAGES) {
  const version = packageVersion(source, pkg)
  console.log(`  ${pkg.padEnd(24)} ${version ?? '(未找到)'}`)
}
console.log('')

let failed = 0
console.log('宿主契约：')
for (const contract of CONTRACTS) {
  const path = locate(source, contract.pkg, contract.file)
  const content = path === undefined ? undefined : source.read(path)
  const ok = content !== undefined && contract.test.test(content)
  if (!ok) failed += 1
  console.log(`  ${ok ? '✅' : '❌'} ${contract.area.padEnd(12)} ${contract.what}`)
  if (!ok) console.log(`      ↳ 期望在 @deepseek-ai/${contract.pkg}/${contract.file} 找到 ${contract.test}`)
}

console.log('')
if (failed === 0) {
  console.log(`结论：${CONTRACTS.length}/${CONTRACTS.length} 项契约仍在，当前 DSH 版本可直接用本插件。`)
} else {
  console.log(`结论：${failed} 项契约不符合预期，先按上面提示核对插件，别直接升级。`)
  process.exitCode = 1
}
