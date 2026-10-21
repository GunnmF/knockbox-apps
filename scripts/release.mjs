#!/usr/bin/env node
/**
 * 商店发版：打好 store-v* tag 并推送到 GitHub，剩下的交给 CI（publish.yml）。
 *
 * 用法：
 *   npm run pack              # 默认 patch：0.1.0 → 0.1.1
 *   npm run pack -- patch     # 0.1.0 → 0.1.1（默认）
 *   npm run pack -- minor     # 0.1.0 → 0.2.0
 *   npm run pack -- major     # 0.1.0 → 1.0.0
 *   npm run pack -- 0.3.0     # 指定版本
 *
 * 前置检查（不满足就中止，不打半截 tag）：
 *   1. 工作区必须干净 —— tag 指向的提交得包含你要发的全部改动；
 *   2. HEAD 必须等于 origin/main —— CI 会把 index.json 提交回 main，
 *      如果 tag 指向一个 main 上没有的提交，商店索引和应用内容会对不上。
 */
import { execFileSync } from 'node:child_process'

const run = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', ...opts }).trim()

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// —— 解析参数 ——
const arg = process.argv[2] ?? 'patch'
const bumps = ['patch', 'minor', 'major']
const explicit = /^\d+\.\d+\.\d+$/.test(arg) ? arg : null
if (!explicit && !bumps.includes(arg)) {
  fail(`不认识的参数 "${arg}"，支持 patch / minor / major / x.y.z`)
}

// —— 前置检查 ——
if (run(['status', '--porcelain'])) {
  fail('工作区还有未提交的改动，先 commit（tag 只包含已提交的内容）')
}
run(['fetch', 'origin', 'main', '--tags'])
const head = run(['rev-parse', 'HEAD'])
let remoteMain = ''
try {
  remoteMain = run(['rev-parse', 'origin/main'])
} catch {
  fail('找不到 origin/main，先确认远程仓库配置')
}
if (head !== remoteMain) {
  fail('HEAD 和 origin/main 不一致：先 git push origin main，再发版')
}

// —— 算下一个版本 ——
const versions = run(['tag', '-l', 'store-v*'])
  .split('\n')
  .map((t) => /^store-v(\d+)\.(\d+)\.(\d+)$/.exec(t))
  .filter(Boolean)
  .map(([, a, b, c]) => [Number(a), Number(b), Number(c)])
if (!versions.length) fail('没找到任何 store-v* tag，无法推断下一个版本')
versions.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
const [major, minor, patch] = versions.at(-1)

const next = explicit
  ? explicit.split('.').map(Number)
  : arg === 'major'
    ? [major + 1, 0, 0]
    : arg === 'minor'
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1]
const tag = `store-v${next.join('.')}`

const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
if (cmp(next, [major, minor, patch]) <= 0) {
  fail(`${tag} 不比当前最新版本 store-v${[major, minor, patch].join('.')} 高`)
}
if (run(['tag', '-l', tag])) fail(`${tag} 已存在`)

// —— 打 tag 并推送（推上去 CI 就自动发版） ——
run(['tag', tag])
run(['push', 'origin', tag])
console.log(`✓ 已推送 ${tag}（上一个：store-v${[major, minor, patch].join('.')}）`)
console.log('  CI 会自动：打包 → 生成 index.json → 上传 Release → 把索引提交回 main')
console.log('  打错了想撤回：')
console.log(`    git push origin :refs/tags/${tag} && git tag -d ${tag}`)
console.log('  CI 进度：https://github.com/GunnmF/knockbox-apps/actions/workflows/publish.yml')
