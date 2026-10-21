# Knockbox 轻应用商店

> 这是 Knockbox 的**官方轻应用仓库** —— 宿主（主程序）从这里读商店列表、下载安装。

设计背景见主仓库的 [docs/PLUGIN_ECOSYSTEM.md](https://github.com/GunnmF/knockbox/blob/master/docs/PLUGIN_ECOSYSTEM.md)。

## 和主程序的关系

宿主只是**沙箱、能力网关、商店**，不实现任何具体功能。这个仓库是功能的来源：
你装完主程序是"空手"的，需要在这里装轻应用才有截图、锁屏这些功能。

## 目录结构

```
apps/
  com.knockbox.screencap/   截图（Snipaste 式选区、标记、取色）
  com.knockbox.lock/        锁屏
  com.knockbox.clipboard/   剪贴板历史（搜索、钉住、一键重新复制）
index.json                  商店索引（由 CI 生成，别手改）
scripts/build-index.mjs     打包 + 生成索引的脚本
```

## 一个轻应用是什么

`apps/<id>/` 下一个文件夹，里面有：

| 文件 | 必需 | 作用 |
|---|---|---|
| `plugin.json` | ✅ | 身份 + 权限声明 + 快捷键 + 调用方式 |
| `entry` 指向的 HTML | ✅ | 插件界面 |
| `icon.svg` | | 商店列表和搜索结果里的图标 |
| `sdk.js` | | 宿主的插件 SDK（发布 `@knockbox/plugin-sdk` 之前先跟着仓库走） |

宿主不实现具体功能，只暴露 API 和权限；插件自己实现自己要做什么。
需要什么权限在 `plugin.json` 里声明，安装时宿主会逐条向用户确认。

## 发一个轻应用

改完 `apps/<id>/` 下的东西，打 tag 就完成「商店发版」：

```bash
npm run pack   # 算出下一个 store-v* 版本，打 tag 并推送，一条命令发版
```

`npm run pack -- patch|minor|major|x.y.z` 可以指定 bump 粒度（默认 patch）。
发版前脚本会检查：工作区干净、HEAD 与 origin/main 一致。

CI 会自动：打包 → 算 sha256 → 生成 index.json → 上传到 Release →
把 index.json 提交回 main。宿主下次打开商店页就能看到。

**版本号只要比上一个高，宿主就会提示升级**（用户可以不升）。

## 需要权限的写法

`plugin.json` 里声明；宿主在安装时逐条向用户确认。常用的：

| 权限 | 用途 |
|---|---|
| `screen:capture` | 截图 |
| `system:lock-screen` | 锁屏 |
| `system:hotkey` | 注册全局快捷键（宿主负责监听，插件只声明） |
| `window:overlay` | 开全屏覆盖层承载自己的 UI |
| `app:background` | 常驻后台（需要监听快捷键 / 剪贴板等事件时） |

快捷键在 `shortcuts` 里声明；`mode: silent` 表示按下时**不唤醒主窗口**直接执行
（比如截图、锁屏），`mode: panel` 表示唤醒主窗口并打开插件面板。

## 常用链接

- 宿主（主程序）：[GunnmF/knockbox](https://github.com/GunnmF/knockbox)
- 设计文档：[docs/PLUGIN_ECOSYSTEM.md](https://github.com/GunnmF/knockbox/blob/master/docs/PLUGIN_ECOSYSTEM.md)
- 插件规范：[docs/PLUGIN_SPEC.md](https://github.com/GunnmF/knockbox/blob/master/docs/PLUGIN_SPEC.md)
