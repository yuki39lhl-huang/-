# AGENTS.md

本文件为 Codex（Codex.ai/code）在此仓库中工作时提供指导。

## 项目概述

一个 Chrome 扩展（Manifest V3），用于在**学习通**平台实现倍速播放视频，同时平台的进度追踪系统仍能正常记录任务点。

无构建系统 — 纯原生 JS，Chrome 直接加载。无依赖，无 package.json。`test/chaoxing-mock.html` 是手动验证页面。

## 架构：双世界注入模式

此扩展使用 Chrome 的 ISOLATED + MAIN 世界分离机制：

| 文件 | 世界 | 能力 |
|------|-------|--------------|
| `content.js` | ISOLATED（内容脚本） | `chrome.storage` API、DOM 访问，但**无法**覆盖 video 元素属性 |
| `main-world.js` | MAIN（页面上下文） | 无 Chrome API 访问权限，但运行在页面上下文中，因此**可以**覆盖 `HTMLMediaElement` 原型 |

**通信流程：**
1. `content.js` 从 `chrome.storage.local` 读取配置，并通过 `window.postMessage({ type: 'STUDY_TONG_SPEED_CONFIG', ... })` 广播。
2. `main-world.js` 监听这些消息，应用倍速和覆盖逻辑。
3. 弹窗也可通过 `chrome.scripting.executeScript` 以 `world: 'MAIN'` 方式直接注入配置到 MAIN 世界。

## 关键文件

- **`manifest.json`** — Manifest V3 声明。`main-world.js` 以 `world: 'MAIN'` 在 `document_start` 阶段运行，`content.js` 以默认 ISOLATED world 运行；两者均 `all_frames: true`，作用于 `*.chaoxing.com` 和本地测试地址。
- **`content.js`** — 管理 chrome.storage 同步，并处理"自动下一集"功能（视频结束时扫描 DOM 中的"下一个"按钮并点击）。
- **`main-world.js`** — 覆盖 video 元素的 `playbackRate`、`currentTime`、`paused`、`ended` 和 `pause()`。在"兼容模式"下，通过让 `currentTime` 以加速后的速率前进，同时仍返回合理的值，来欺骗页面自身的进度追踪。运行 500ms 间隔循环检查已播放时长，当视频播放足够时间后允许其"结束"。
- **`popup/popup.html`** — 扩展弹窗界面，包含速度滑块（0.5x–16x）、预设按钮、启用/兼容/自动下一集开关，以及快捷键。
- **`popup/popup.js`** — 弹窗逻辑。通过 `chrome.storage.local` 加载/保存配置，并通过 `chrome.scripting.executeScript` 将设置注入当前标签页的 MAIN 世界。

## 兼容模式机制

当 `compatMode` 为 true 时，`main-world.js` 覆盖 video 属性，使平台的追踪脚本看到合理的播放状态：

- **`currentTime` getter**：按墙钟时间稳定推进，并在兼容模式下限制最大进度速率，避免平台检测到异常快进。
- **`currentTime` setter**：如果页面尝试跳到 ≥95% 的位置，会被重定向回 30%。
- **`paused` getter**：始终返回 `false`（从未暂停）。
- **`ended` getter**：始终返回 `false`，直到控制循环判定进度已稳定达到 90% 任务点阈值，届时设置 `allowEnd = true` 并使用真实 getter。
- **`playbackRate` setter**：原型补丁拦截页面任何修改速率的尝试，重定向到期望的速度。

## chrome.storage.local 中的配置键

| 键 | 类型 | 默认值 | 说明 |
|-----|------|---------|-------------|
| `speed` | number | 2 | 播放速度倍率（0.5–16） |
| `enabled` | boolean | true | 是否启用速度控制 |
| `compatMode` | boolean | true | 启用进度追踪兼容覆盖 |
| `autoNext` | boolean | true | 视频结束时自动点击下一个视频 |
| `videoEndedAt` | number | — | 视频结束时写入的时间戳（触发其他 frame 的自动下一集） |

## 在 Chrome 中加载扩展

1. 打开 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `learning-player-speed-control/` 目录
4. 扩展会在 `*.chaoxing.com` 页面上激活
