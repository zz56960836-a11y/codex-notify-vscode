# 安全说明 / Security

## 密钥保存在哪里
| 数据 | 位置 |
| --- | --- |
| Bark 设备 Key、加密 Key | VS Code SecretStorage → Windows 凭据管理器（DPAPI 加密，仅当前 Windows 用户可读） |
| 其他设置（开关、服务器地址、加密模式） | VS Code 用户设置 `codexNotify.*`（不含任何密钥） |
| 事件暂存 | `%LOCALAPPDATA%\codex-notify\spool`，插件读取后立即删除 |

- 密钥**不会**写入 settings.json、日志、事件文件或安装包，也不会通过 Settings Sync 同步。
- 设置面板只会拿到密钥的提示信息（末 4 位或位数），不会拿到完整密钥。
- 网络请求只发往你配置的 Bark 服务器，且必须是 HTTPS。

## hooks 做了什么
本插件在 `~/.codex/hooks.json`（Windows 和所选 WSL）中添加 3 个异步 hook，命令都包含 `codex-notify-hooks`：
- Windows：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\codex-notify\codex-notify-hooks\hook.ps1"`
- WSL：`python3 ~/.local/share/codex-notify-hooks/hook.py`

脚本源码在 [hooks/](hooks/)。它们只读取 Codex 通过标准输入传入的事件，提取类型、会话 ID、项目路径和最多 200 字的摘要，然后写入 spool 文件夹，不联网。

"一键启用"通过官方 app-server API 只信任以上 3 个 hook，不会信任其他任何 hook。面板中的"hook 命令（供审核）"可以查看实际命令。修改 `hooks.json` 前会先在同目录备份为 `hooks.json.bak-codex-notify-<时间>`。

## 通知内容
默认只包含：通知类型、项目文件夹名、6 位会话编号、来自 Windows 还是 WSL。打开"带上回复摘要"后，会多出最多 80 个字的内容：常规 Bark 模式下这段文字会经过 Bark 服务器和 Apple 推送服务；加密模式下只有手机能解开。

## 报告漏洞
请**不要**在公开 Issue 里贴出漏洞细节。请使用 GitHub 的 **Security → Report a vulnerability**（私密报告）。
