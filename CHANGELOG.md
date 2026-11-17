# 更新记录 / Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-17

首个公开版本。First public release.

### 新增
- 三类通知：任务完成、等待回答、等待审批。每类都可以单独选择发到 Windows 通知、Bark，或两边都发。
- Bark 常规推送和加密推送（AES-128/192/256，CBC/GCM），加密失败不会退回明文。
- 图形化设置面板：
  - 一键安装并信任 Codex hooks（Windows 本地 + WSL）
  - 按平台显示 hook 是否安装、是否信任、最近一次事件
- Codex 版本和安装路径自动识别（优先用 VS Code 当前启用的扩展，跳过已废弃版本）。
- 密钥存在 VS Code SecretStorage（Windows 凭据管理器）。
- 可选：通知里带上回复摘要、VS Code 在前台时不弹 Windows 通知、Bark 时效性通知。
- 打包时扫描密钥和个人信息。

### 设计说明
- 只使用 Codex 官方 hooks，不替换 Codex 启动入口、不包含可执行文件。早期的内部原型用自编译 exe 转发 Codex 进程，被 Windows 智能应用控制拦截后，Codex 无法启动；本版本彻底去掉了这条路线。

[1.0.0]: https://github.com/zz56960836-a11y/codex-notify-vscode/releases/tag/v1.0.0
