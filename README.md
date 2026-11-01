# dsh-extension

DeepSeek Harness（DSH）桌面端的一个小插件，把三件常用事收进顶部一排按钮：

- **重启 DSH**：一键重启应用（计划任务 + 树杀 + 立即拉起，不弹终端窗口）。
- **下次打开的窗口模式**：切换下次启动是全屏还是小窗口。
- **极简模式**：把整个窗口收成一块 625×272 的米色横条，只保留任务行、对话和输入框，支持权限切换与「还原」。

> 仅支持 Windows + DSH 桌面端。

## 功能

### 重启

- 顶部「⟳ 重启 DSH」按钮，确认后重启；
- 先关闭应用外壳再清理 Host，避免触发 DSH 的启动失败恢复弹窗；
- 重启脚本通过计划任务在用户会话执行：`taskkill` 树杀、80ms 轮询、启动确认后立即退出。

### 窗口模式

按钮显示「下次打开：全屏 / 小窗口」。设置保存到 `$DSH_HOME/dsh-extension/config.json`，下次启动时由窗口守护脚本应用：

- `maximized`：最大化；
- `normal`：还原为默认窗口大小。

### 极简模式

- 点击「极简」按钮进入极简；最小化按钮保持系统默认行为（收进任务栏），不再触发极简；
- 极简是一套独立的米色界面：隐藏侧栏、标题栏、右侧面板，只保留任务行 + 对话 + 输入框；
- 任务行包含状态灯、当前会话标题、权限切换、还原按钮；
- 权限可在「工作区内修改 / 完全权限」之间切换；
- 聊天区字号 10px，图片限制为左侧缩略图，避免挤占输入框；
- 点击「还原」回到完整界面。

## 安装

```sh
dsh plugin --profile desktop add <本仓库目录或 tgz>
```

安装后需要完整退出 DSH 再打开一次。

## 配置

| 路径 | 说明 |
| --- | --- |
| `$DSH_HOME/dsh-extension/config.json` | `{"mode":"maximized"}` 或 `{"mode":"normal"}` |
| `$DSH_HOME/dsh-extension/extension.log` | 运行日志（窗口、重启、注入） |

## 卸载

```sh
dsh plugin --profile desktop remove dsh-extension
```

再删除 `$DSH_HOME/dsh-extension` 目录；计划任务 `DSH-Extension-Watcher` 可用
`schtasks /Delete /TN DSH-Extension-Watcher /F` 清理。

## 说明

- 插件通过 `webserver/index-inject` 注入 UI 脚本，不依赖客户端模块加载器；
- 窗口操作通过 Win32 `SetWindowPos` 实现；
- 极简模式会临时摘掉 `data-dsh-skin`，退出时恢复，避免第三方皮肤影响配色。

## License

MIT
