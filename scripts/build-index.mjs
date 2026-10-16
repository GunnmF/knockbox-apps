#!/usr/bin/env node
/**
 * 打包 apps/ 下的轻应用并生成商店索引 index.json。
 *
 * 为什么索引必须由脚本生成：索引里有每个包的 sha256。手写的话每次发版都要
 * 人肉复制粘贴，漏一处就是「装不上」或者「校验失败但不知道差在哪」。
 * 所以这个脚本**自己打包、自己算校验和**，不存在占位值。
 *
 * 用法：
 *   node scripts/build-index.mjs                        # 本地预览
 *   node scripts/build-index.mjs --base <下载前缀> --write
 *
 * CI（.github/workflows/publish.yml）里传 Release 的下载目录并加 --write。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const base = arg('--base', 'https://github.com/GunnmF/knockbox-apps/releases/download/PLACEHOLDER')
const dist = join(root, arg('--dist', 'dist'))
const outPath = join(root, arg('--out', 'index.json'))
const write = argv.includes('--write')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const appsDir = join(root, 'apps')
const ids = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const plugins = []
const problems = []

for (const id of ids) {
  const dir = join(appsDir, id)
  const manifestPath = join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    problems.push(`${id}: 没有 plugin.json`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    problems.push(`${id}: plugin.json 解析失败 —— ${e.message}`)
    continue
  }

  // 目录名必须和 id 一致，否则索引里的 id 和实际下载到的包对不上
  if (manifest.id !== id) {
    problems.push(`${id}: 目录名与 manifest.id（${manifest.id}）不一致`)
    continue
  }

  // 打包格式：zip，且 plugin.json 必须在压缩包**根目录**（宿主的 extract_zip
  // 要求如此，外面多套一层目录会直接被拒）
  const fileName = `${id}-${manifest.version}.kbplugin`
  const outFile = join(dist, fileName)
  try {
    execFileSync('zip', ['-r', '-q', '-X', outFile, '.'], { cwd: dir, stdio: 'pipe' })
  } catch (e) {
    problems.push(`${id}: 打包失败 —— ${e.stderr?.toString() ?? e.message}`)
    continue
  }

  const bytes = readFileSync(outFile)
  plugins.push({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    // 列表页展示用。**安装时以包内 plugin.json 为准**，这个字段不可信
    // （见 docs/PLUGIN_SPEC.md §7.3）
    permissions: manifest.permissions ?? [],
    icon: manifest.icon
      ? `https://raw.githubusercontent.com/GunnmF/knockbox-apps/main/apps/${id}/${manifest.icon}`
      : '',
    download: `${base}/${fileName}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
}

if (problems.length) {
  console.error('✗ 以下轻应用有问题，不会进索引：')
  for (const p of problems) console.error(`    ${p}`)
  process.exit(1)
}

const index = {
  name: 'Knockbox 官方轻应用商店',
  updatedAt: new Date().toISOString(),
  plugins,
}

const json = JSON.stringify(index, null, 2) + '\n'
if (write) {
  writeFileSync(outPath, json)
  console.log(`✓ dist/ 里 ${plugins.length} 个包，索引已写入 ${outPath}`)
} else {
  console.log(json)
}
