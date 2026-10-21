// 内置轻应用：剪贴板历史。
//
// 唤起方式：输入关键词（剪贴板 / clipboard / paste…），或快捷键
// CmdOrCtrl+Shift+V（mode: panel —— 唤醒主窗口并直接打开本面板）。
//
// 历史从哪来：
//   1. 每次被唤起时快照一次当前剪贴板 —— 用户按快捷键前复制的内容能立刻进来；
//   2. 面板打开期间每 0.8s 轮询一次，发现新内容就记下来。
// 宿主目前还没有常驻后台运行时（app:background 只做了清单校验，并不会把插件
// 持久拉起），也没有 system:clipboard-watch 的事件推送，所以「面板关着期间
// 复制的内容」暂时记不到。等宿主支持后台常驻后，这个轮询循环原样就能用。
//
// 数据存在插件私有的 storage:local，其它插件读不到。新→旧排序，钉住的单独
// 一段在最前；同一段文本重复复制只更新时间，不会产生重复条目。

import { connect } from './sdk.js'

const HISTORY_KEY = 'history'
const POLL_MS = 800

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

  /** @type {{id: string, text: string, time: number, pinned: boolean}[]} */
  let items = (await kb.storage.get(HISTORY_KEY).catch(() => null)) ?? []
  /** 最近一次见到的剪贴板内容，轮询靠它判断"有没有复制新东西"。 */
  let lastSeen = ''
  /** 面板渲染后由 render 回调赋值；轮询在面板起来之前也可能先跑完一轮。 */
  let renderList = () => {}

  const save = () => kb.storage.set(HISTORY_KEY, items).catch(() => {})

  /**
   * 记录一段剪贴板文本。返回是否有变化（新增或条目被顶到最前）。
   * 去重靠内容本身：同一段文本重复复制只是把已有条目挪到最前并刷新时间，
   * 钉住状态保留。
   */
  function record(text) {
    if (typeof text !== 'string' || !text.trim() || text === lastSeen) return false
    lastSeen = text
    const existing = items.find((it) => it.text === text)
    if (existing) items = items.filter((it) => it !== existing)
    items.unshift({
      id: existing?.id ?? newId(),
      text,
      time: Date.now(),
      pinned: existing?.pinned ?? false,
    })
    // 超出上限时从尾部删未钉住的；钉住的不计入条数
    let unpinned = items.filter((it) => !it.pinned)
    while (unpinned.length > maxItems) {
      const drop = unpinned.pop()
      items = items.filter((it) => it !== drop)
    }
    return true
  }

  async function poll() {
    try {
      if (record(await kb.clipboard.readText())) {
        await save()
        renderList()
      }
    } catch {
      // 读失败（比如剪贴板里是图片）跳过这一轮就好
    }
  }

  // 唤起的这一刻先快照一次：用户复制完按快捷键，内容应该已经在列表里
  try {
    record(await kb.clipboard.readText())
  } catch {}
  await save()
  const timer = setInterval(poll, POLL_MS)

  kb.setPanel({
    title: '剪贴板历史',
    height: 440,
    render: (box, ctx) => {
      box.style.cssText =
        'display:flex;flex-direction:column;height:100%;font:13px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;color:rgba(255,255,255,.92)'

      const list = document.createElement('div')
      list.style.cssText = 'flex:1;overflow:auto;min-height:0'
      const footer = document.createElement('div')
      footer.style.cssText =
        'flex:none;display:flex;align-items:center;justify-content:space-between;padding-top:8px;color:rgba(255,255,255,.45);font-size:12px'
      const count = document.createElement('span')
      const clearBtn = button('清空', async () => {
        items = clearKeepPinned ? items.filter((it) => it.pinned) : []
        await save()
        renderList()
      })
      footer.append(count, clearBtn)
      box.append(list, footer)

      /** 当前过滤后的可见条目（钉住的在前，各自按时间倒序）。 */
      function visible() {
        const q = ctx.query.trim().toLowerCase()
        const hit = q ? items.filter((it) => it.text.toLowerCase().includes(q)) : items
        return [...hit].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time - a.time)
      }

      async function copyBack(item) {
        try {
          await kb.clipboard.writeText(item.text)
          lastSeen = item.text // 自己写回去的内容别让轮询当成"新复制"
          ctx.close()
        } catch (e) {
          count.textContent = `复制失败：${e.message ?? e}`
        }
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

        for (const item of view) {
          const row = document.createElement('div')
          row.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer'
          row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,.08)')
          row.onmouseleave = () => (row.style.background = 'transparent')
          row.onclick = () => void copyBack(item)

          const body = document.createElement('div')
          body.style.cssText = 'flex:1;min-width:0'
          const preview = document.createElement('div')
          preview.style.cssText =
            'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;word-break:break-all'
          preview.textContent = item.text
          const time = document.createElement('div')
          time.style.cssText = 'font-size:11px;color:rgba(255,255,255,.4);margin-top:2px'
          time.textContent = ago(item.time)
          body.append(preview, time)

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
          list.appendChild(row)
        }
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
