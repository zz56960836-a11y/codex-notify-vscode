# 设计说明

## 总体结构

```
┌─────────── Windows ───────────────────────────────────────────────┐
│ VS Code (UI 端)                                                    │
│  └─ Codex Notify 扩展 (extensionKind: ui)                          │
│       ├─ extension.js   每秒扫描 spool → 去重 → 按设置分发            │
│       ├─ lib/notify.js  Windows Toast（PowerShell + WinRT）/ Bark   │
│       ├─ lib/panel.js   设置面板（Webview，严格 CSP）                 │
│       ├─ lib/hooks.js   写入/移除 ~/.codex/hooks.json 中自己的条目    │
│       └─ lib/codexTrust.js 临时启动官方 app-server 查询/写入信任       │
│                                                                    │
│ %LOCALAPPDATA%\codex-notify\spool\*.json  ◀── hook 写入            │
│                                                                    │
│ Codex (Windows 本地窗口) ── hook.ps1 ──────────┘                    │
└────────────────────────────────────────────────────────────────────┘
┌─────────── WSL ───────────┐
│ Codex (WSL 远程窗口)       │
│  └─ hook.py ── 写入 /mnt/c/…/spool ──▶（同一个文件夹）
└───────────────────────────┘
```

## 为什么用 hooks，而不是转发 Codex 进程

早期原型把 VS Code 设置 `chatgpt.cliExecutable` 指向一个自编译的转发程序（exe），由它启动真正的 Codex，并从中截取协议消息。这样做有两个根本问题：

1. **转发程序挡在 Codex 启动路径上**：它一出错，Codex 就打不开（表现为"登录不上"）。
2. **Windows 智能应用控制**会拦截没有签名、没有信誉的 exe。一旦拦截，Codex 无法启动，重新编译也没用。

官方 hooks 是 Codex 主动调用的旁路：hook 设为 `async`，失败也只是少一条通知，不会影响 Codex 本身；hook 脚本由 Windows 自带的 PowerShell 或 WSL 里的 python3 执行，不需要任何新的可执行文件。

## 事件映射

| Codex hook | 条件 | 通知类型 |
| --- | --- | --- |
| `Stop` | 不是子 Agent（没有 `agent_id`） | 任务完成 |
| `PreToolUse` | 工具名以 `request_user_input` 结尾 | 等待回答 |
| `PermissionRequest` | — | 等待审批 |

spool 记录格式（`v: 1`）：`kind, session, turn, id, cwd, summary(≤200), platform, ts`。

## 可靠性设计

- **多个 VS Code 窗口**：每个窗口都会扫描 spool。领取事件时用原子 `rename` 改名，只有一个窗口能领到，所以不会重复通知。
- **去重**：去重键为 `平台|会话|轮次|类型|id`，保留 1 小时。审批事件没有稳定 ID，所以 5 秒内的重复才视为同一条。
- **过期**：超过 15 分钟的事件直接丢弃（例如 VS Code 关着的时候积压的事件）。
- **前台判断**：每个窗口获得焦点时写一个心跳文件，其他窗口据此判断"VS Code 是否在前台"。
- **残留清理**：超过 10 分钟的 `.work` 和临时文件会被清理。

## 信任 hook

Codex 会给每个 hook 计算一个 hash。只有当 `config.toml` 中的 `hooks.state."<key>".trusted_hash` 与当前 hash 一致时，hook 才会执行。本插件的做法：

1. 找到官方 Codex 可执行文件：
   - Windows：优先用 VS Code 当前启用的 `openai.chatgpt` 扩展；否则选 `~/.vscode/extensions` 里版本最新、且没有被 `.obsolete` 标记的那个。
   - WSL：选 `~/.vscode-server(-insiders)/extensions` 里最新的未废弃版本。
2. 以 `codex --no-daemon app-server` 启动一个临时进程，调用 `initialize` → `hooks/list`。
3. 只挑出命令里包含 `codex-notify-hooks` 的条目，用 `config/batchWrite` 写入 `enabled=true` 和 `trusted_hash=currentHash`。这和 Codex 设置页 "Trust" 按钮发出的请求完全一样。
4. 再调用一次 `hooks/list`，确认状态是 `trusted`。

## Bark 加密

- 算法由 Key 长度决定：16/24/32 字节分别对应 AES-128/192/256。
- CBC：每条消息随机生成 16 字符的 IV，PKCS7 填充。
- GCM：每条消息随机生成 12 字符的 IV，16 字节认证标签追加在密文后面。
- 请求体为 `{device_key, ciphertext, iv}`，标题和正文都在密文里。

## 测试

- `test/unit.test.js`：加解密往返、Key 校验、Bark 请求格式（替换掉网络请求）、hooks.json 合并和移除。
- `test/panel.test.js`：用替身 `vscode` 模块加载扩展，检查面板脚本语法、控件是否齐全、CSP。
- `test/test_hook.py`：hook.py 的事件映射、截断、忽略无关输入、不向标准输出写任何内容。
- 需要真实环境的部分（Windows Toast、hook.ps1、app-server 信任）不在 CI 里跑，发版前请在 Windows 上手动验证一次。见 [发布检查清单](RELEASING.md)。
