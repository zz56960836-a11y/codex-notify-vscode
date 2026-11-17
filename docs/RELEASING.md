# 发布检查清单

## 每次发版

1. 修改 `package.json` 里的 `version`，例如 `1.0.1`。
2. 在 `CHANGELOG.md` 顶部写上这个版本改了什么。
3. 本地测试并打包：
   ```bash
   npm test
   python3 scripts/build_vsix.py
   ```
4. 在 Windows 上手动验证一次（CI 跑不了这些）：
   - 安装 `dist/*.vsix`，然后 Reload Window
   - 面板 → 一键安装并启用 → 两个平台都显示 ✓ 已信任
   - 测试 Windows 通知、测试 Bark
   - 在 Codex 里发一句话，确认收到"任务完成"
5. 提交并打标签：
   ```bash
   git add -A
   git commit -m "Release v1.0.1"
   git tag v1.0.1
   git push && git push --tags
   ```
6. GitHub Actions（`.github/workflows/release.yml`）会自动跑测试、打包，并在 Releases 页面创建 `v1.0.1`，附上 `.vsix` 和 `.sha256`。

## 第一次发布前

- [ ] 把所有 `YOUR_NAME` / `your-name` 换成你的 GitHub 用户名（`package.json`、`LICENSE`、`CHANGELOG.md`）
- [ ] 在 `.local-denylist` 里写上你的个人字符串：Windows 用户名、WSL 用户名、邮箱等，每行一个
- [ ] 运行 `python3 scripts/build_vsix.py`，确认没有 REFUSED
- [ ] 运行 `git grep -n -i "<你的用户名>"`，确认结果为空
- [ ] 可选：在 `docs/images/panel.png` 放一张面板截图，并在 README 中取消对应注释
