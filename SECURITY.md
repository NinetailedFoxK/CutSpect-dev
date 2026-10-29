# 安全策略（Security Policy）

## 报告漏洞

请不要通过公开 Issue 披露安全漏洞。

- 本 fork（`NinetailedFoxK/CutSpect-dev`）请用 GitHub 的
  [Security Advisories](https://github.com/NinetailedFoxK/CutSpect-dev/security/advisories)
  私密报告。
- 上游开发仓是 `ZevinZhao/CutSpect-dev`。面向用户的安装包在公开发布仓
  （由 `RELEASE_REPO` 指定），不要把源码仓库当成下载入口。

也可以发送邮件给维护者（见仓库主页）。我们会尽快确认与修复。

请在报告中尽量包含：

- 受影响版本（`package.json` 的 version）与操作系统；
- 复现步骤与最小样例；
- 影响评估（例如本地文件读取、路径穿越、命令执行等）。

## 支持范围

- 当前仅维护最新发布版本。
- 视频与项目数据留在本机，不上传。可选的更新检查会联网访问更新服务器。
- 媒体读取经 `laipian-media:` 受控协议。渲染层拿不到素材或导出文件的绝对路径。
- 打包后的 IPC 只信任 `file://`。开发态才额外信任 Vite。
- 未签名 / ad-hoc 构建禁用静默自动更新，需要手动覆盖安装。应用内不含更新用的 Token。

## 密钥与证书

- **不要**在 Issue、PR、日志或提交中附带密码、Token、签名证书或私钥。
- 正式签名所需的证书/密码只能放在 **GitHub Secrets** 或外部签名服务中。
- 仓库已在 `.gitignore` 排除 `*.pem` / `*.p12` / `*.cer` / `*.pfx` / `*.key` / `.env`。

## 平台安全边界

- 本应用不会要求用户关闭系统安全功能。
- macOS 正式公开发行需要 Developer ID 签名与公证。
- Windows 正式公开发行需要代码签名，否则可能出现 SmartScreen 警告。
- 未签名或 ad-hoc（`codesign --sign -`）测试包禁用静默更新，请手动覆盖安装。
  本应用不会要求关闭系统安全功能。