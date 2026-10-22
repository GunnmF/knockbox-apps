// 内置轻应用：剪贴板历史。
//
// 唤起方式：输入关键词（剪贴板 / clipboard / paste…），或快捷键
// CmdOrCtrl+Shift+V（mode: panel —— 唤醒主窗口并直接打开本面板）。
//
// 支持三种形态：文本、图片（PNG）、文件/文件夹列表（只展示名称和图标，
// 点击照常写回剪贴板）。形态判定在宿主侧：文件 > 图片 > 文本。
//
// 历史从哪来：
//   1. 每次被唤起时快照一次当前剪贴板 —— 用户按快捷键前复制的内容能立刻进来；
//   2. 面板打开期间每 0.8s 轮询一次，发现新内容就记下来。
// 宿主目前还没有常驻后台运行时，也没有剪贴板事件推送，所以「面板关着期间
// 复制的内容」暂时记不到。等宿主支持后台常驻后，这个轮询循环原样就能用。
//
// 数据存在插件私有的 storage:local，其它插件读不到。新→旧排序，钉住的单独
// 一段在最前；同一份内容重复复制只更新时间，不会产生重复条目。

import { connect } from './sdk.js'

const HISTORY_KEY = 'history'
const POLL_MS = 800
/** 图片超过这个体积（dataUrl 字符数 ≈ 1.5MB 二进制）就缩到 640px 再入库。
 *  历史里塞一堆全尺寸截图，storage 文件会膨胀到读写都卡。 */
const MAX_IMAGE_DATAURL = 2_000_000

async function main() {
  const kb = await connect()

  // 缺权限时静默退出会让用户以为软件坏了 —— 把原因顶到面板上（同锁屏的处理）
  const missing = [
    ['clipboard:read', kb.clipboard?.readText],
    ['clipboard:write', kb.clipboard?.writeText],
    ['storage:local', kb.storage?.get],
  ].filter(([, ok]) => !ok).map(([perm]) => perm)
  if (missing.length) {
    kb.setPanel({
      title: '剪贴板 · 出错',
      height: 140,
      render: (box) => {
        box.textContent = `未授予权限：${missing.join('、')}`
      },
    })
    return
  }

  const maxItems = parseInt(kb.setting?.maxItems, 10) || 100
  const clearKeepPinned = kb.setting?.clearKeepPinned !== false

  // 旧版宿主没有 readAny/writeAny（UNKNOWN_METHOD），降级成纯文本模式
  let anyMode = Boolean(kb.clipboard.readAny && kb.clipboard.writeAny)
  const readClipboard = async () => {
    if (anyMode) {
      try {
        return await kb.clipboard.readAny()
      } catch (e) {
        if (e?.code === 'UNKNOWN_METHOD') {
          anyMode = false
        } else {
          throw e
        }
      }
    }
    const text = await kb.clipboard.readText()
    return text ? { kind: 'text', text } : { kind: 'none' }
  }
  const writeClipboard = (item) =>
    anyMode
      ? kb.clipboard.writeAny(payloadOf(item))
      : kb.clipboard.writeText(item.kind === 'text' ? item.text : '')

  /** @type {{id: string, kind: string, time: number, pinned: boolean}[]} */
  let items = ((await kb.storage.get(HISTORY_KEY).catch(() => null)) ?? [])
    // 1.0.0 的存量条目没有 kind 字段，一律按文本迁移
    .map((it) => (it.kind ? it : { ...it, kind: 'text' }))
  /** 最近一次见到内容的去重键，轮询靠它判断"有没有复制新东西"。 */
  let lastSeen = ''
  /** 面板渲染后由 render 回调赋值；轮询在面板起来之前也可能先跑完一轮。 */
  let renderList = () => {}

  const save = () => kb.storage.set(HISTORY_KEY, items).catch(() => {})

  /** 去重键：同一份内容重复复制只挪位置。图片不比整个 dataUrl（可能几 MB）。 */
  function keyOf(p) {
    switch (p.kind) {
      case 'text':
        return `t:${p.text}`
      case 'image':
        return `i:${p.dataUrl.length}:${p.dataUrl.slice(-64)}`
      case 'files':
        return `f:${p.files.map((f) => f.path).join('\n')}`
      default:
        return ''
    }
  }

  /** 入库前的清洗：空白文本丢弃，超大图片压缩。 */
  async function normalize(p) {
    if (p.kind === 'text') return p.text.trim() ? p : null
    if (p.kind === 'files') return p.files.length ? p : null
    if (p.kind === 'image') {
      if (p.dataUrl.length <= MAX_IMAGE_DATAURL) return p
      try {
        return { ...(await shrinkImage(p.dataUrl)), partial: true }
      } catch {
        return null // 图都画不出来（数据坏了），这条放弃
      }
    }
    return null // kind:none 等
  }

  /**
   * 记录一条剪贴板内容。返回是否有变化（新增或条目被顶到最前）。
   * 去重靠内容键：重复复制把已有条目挪到最前并刷新时间，钉住状态保留。
   */
  function record(p) {
    const key = keyOf(p)
    if (!key || key === lastSeen) return false
    lastSeen = key
    const existing = items.find((it) => keyOf(it) === key)
    if (existing) items = items.filter((it) => it !== existing)
    items.unshift({
      id: existing?.id ?? newId(),
      kind: p.kind,
      time: Date.now(),
      pinned: existing?.pinned ?? false,
      ...(p.kind === 'text' ? { text: p.text } : {}),
      ...(p.kind === 'image'
        ? { dataUrl: p.dataUrl, width: p.width, height: p.height, partial: Boolean(p.partial) }
        : {}),
      ...(p.kind === 'files' ? { files: p.files } : {}),
    })
    // 超出上限时从尾部删未钉住的；钉住的不计入条数
    const unpinned = items.filter((it) => !it.pinned)
    while (unpinned.length > maxItems) {
      const drop = unpinned.pop()
      items = items.filter((it) => it !== drop)
    }
    return true
  }

  async function poll() {
    try {
      const p = await normalize(await readClipboard())
      if (p && record(p)) {
        await save()
        renderList()
      }
    } catch {
      // 读失败（比如剪贴板里是读不了的形态）跳过这一轮就好
    }
  }

  // 唤起的这一刻先快照一次：用户复制完按快捷键，内容应该已经在列表里
  try {
    const p = await normalize(await readClipboard())
    if (p) record(p)
  } catch {}
  await save()
  const timer = setInterval(poll, POLL_MS)

  kb.setPanel({
    title: '剪贴板历史',
    height: 440,
    render: (box, ctx) => {
      box.style.cssText =
        'display:flex;flex-direction:column;height:100%;font:13px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;color:rgba(255,255,255,.92)'

      // 操作栏放顶部：底部要滚到底才够得着，「清空」是最常用按钮之一
      const bar = document.createElement('div')
      bar.style.cssText =
        'flex:none;display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;color:rgba(255,255,255,.45);font-size:12px'
      const count = document.createElement('span')
      const clearBtn = button('清空', async () => {
        items = clearKeepPinned ? items.filter((it) => it.pinned) : []
        await save()
        renderList()
      })
      bar.append(count, clearBtn)

      const list = document.createElement('div')
      list.style.cssText = 'flex:1;overflow:auto;min-height:0'
      box.append(bar, list)

      /** 当前过滤后的可见条目（钉住的在前，各自按时间倒序）。 */
      function visible() {
        const q = ctx.query.trim().toLowerCase()
        const hit = q ? items.filter((it) => searchText(it).includes(q)) : items
        return [...hit].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time - a.time)
      }

      async function copyBack(item) {
        try {
          await writeClipboard(item)
          lastSeen = keyOf(item) // 自己写回去的内容别让轮询当成"新复制"
          ctx.close()
        } catch (e) {
          count.textContent = `复制失败：${e.message ?? e}`
        }
      }

      function rowFor(item) {
        const row = document.createElement('div')
        row.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer'
        row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,.08)')
        row.onmouseleave = () => (row.style.background = 'transparent')
        row.onclick = () => void copyBack(item)

        const body = document.createElement('div')
        body.style.cssText = 'flex:1;min-width:0'

        if (item.kind === 'image') {
          const img = document.createElement('img')
          img.src = item.dataUrl
          img.style.cssText =
            'max-width:100%;max-height:72px;border-radius:6px;display:block;background:rgba(255,255,255,.06)'
          const meta = document.createElement('div')
          meta.style.cssText = 'font-size:11px;color:rgba(255,255,255,.4);margin-top:3px'
          const dims = item.width && item.height ? ` ${item.width}×${item.height}` : ''
          meta.textContent = `图片${dims}${item.partial ? '（已压缩）' : ''} · ${ago(item.time)}`
          body.append(img, meta)
        } else if (item.kind === 'files') {
          const first = item.files[0]
          const title = document.createElement('div')
          title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          const rest = item.files.length > 1 ? ` 等 ${item.files.length} 项` : ''
          title.textContent = `${first.dir ? '📁' : '📄'} ${first.name}${rest}`
          // 悬浮看完整路径（多文件全列出）
          title.title = item.files.map((f) => f.path).join('\n')
          const meta = document.createElement('div')
          meta.style.cssText = 'font-size:11px;color:rgba(255,255,255,.4);margin-top:2px'
          meta.textContent = ago(item.time)
          body.append(title, meta)
        } else {
          const preview = document.createElement('div')
          preview.style.cssText =
            'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;word-break:break-all'
          preview.textContent = item.text
          const meta = document.createElement('div')
          meta.style.cssText = 'font-size:11px;color:rgba(255,255,255,.4);margin-top:2px'
          meta.textContent = ago(item.time)
          body.append(preview, meta)
        }

        const pinBtn = button(item.pinned ? '📌' : '📍', async (e) => {
          e.stopPropagation()
          item.pinned = !item.pinned
          await save()
          renderList()
        })
        pinBtn.title = item.pinned ? '取消钉住' : '钉住'
        const delBtn = button('✕', async (e) => {
          e.stopPropagation()
          items = items.filter((it) => it !== item)
          await save()
          renderList()
        })
        delBtn.title = '删除'

        row.append(body, pinBtn, delBtn)
        return row
      }

      renderList = () => {
        const view = visible()
        list.textContent = ''
        count.textContent = ctx.query.trim()
          ? `命中 ${view.length} / 共 ${items.length} 条`
          : `共 ${items.length} 条 · 回车复制第一条`

        if (!view.length) {
          const empty = document.createElement('div')
          empty.style.cssText = 'padding:32px 0;text-align:center;color:rgba(255,255,255,.4)'
          empty.textContent = items.length
            ? '没有匹配的条目'
            : '还没有剪贴板记录 —— 复制点什么，这里会记下来'
          list.appendChild(empty)
          return
        }
        for (const item of view) list.appendChild(rowFor(item))
      }

      // 宿主输入框是唯一输入源：面板打开时打字过滤列表，回车复制第一条
      ctx.onQueryChange(renderList)
      ctx.onSubmit(() => {
        const first = visible()[0]
        if (first) void copyBack(first)
      })

      renderList()
    },
  })

  // 面板被宿主回收时 iframe 整个销毁，轮询随之停止；这里不需要清 timer，
  // 留着它只是为了语义完整（比如宿主以后支持面板隐藏而不销毁）
  void timer
}

/** 写回剪贴板的载荷：历史条目里存的展示字段原样带回去。 */
function payloadOf(item) {
  switch (item.kind) {
    case 'image':
      return { kind: 'image', dataUrl: item.dataUrl }
    case 'files':
      return { kind: 'files', files: item.files }
    default:
      return { kind: 'text', text: item.text ?? '' }
  }
}

/** 过滤用的可搜索文本：文本搜内容，文件搜名称，图片给一个固定词。 */
function searchText(item) {
  switch (item.kind) {
    case 'text':
      return item.text.toLowerCase()
    case 'files':
      return item.files.map((f) => f.name).join('\n').toLowerCase()
    case 'image':
      return '图片 image photo'
    default:
      return ''
  }
}

/** 超大图缩到 640px 以内（历史里不囤全尺寸截图，见 MAX_IMAGE_DATAURL）。 */
async function shrinkImage(dataUrl) {
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
    img.src = dataUrl
  })
  const scale = Math.min(1, 640 / Math.max(img.width, img.height, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

function button(label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.style.cssText =
    'flex:none;border:0;background:transparent;color:rgba(255,255,255,.55);font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px'
  btn.onmouseenter = () => (btn.style.background = 'rgba(255,255,255,.12)')
  btn.onmouseleave = () => (btn.style.background = 'transparent')
  btn.onclick = onClick
  return btn
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function ago(time) {
  const s = Math.max(0, (Date.now() - time) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = new Date(time)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

main().catch((e) => {
  // 连宿主都没连上：同样要显示而不是沉默
  document.body.textContent = `连接宿主失败：${e.message ?? e}`
})
