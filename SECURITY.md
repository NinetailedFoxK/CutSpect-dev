# 安全策略（Security Policy）

## 报告漏洞

请不要通过公开 Issue 披露安全漏洞。请使用 GitHub 的
[Security Advisories](https://github.com/ZevinZhao/CutSpect/security/advisories)
私密报告，或发送邮件给维护者（见仓库主页）。我们会尽快确认与修复。

请在报告中尽量包含：

- 受影响版本（`package.json` 的 version）与操作系统；
- 复现步骤与最小样例；
- 影响评估（例如本地文件读取、路径穿越、命令执行等）。

## 支持范围

- 当前仅维护最新发布版本。
- 本应用为离线桌面工具：不联网、不上传用户素材；媒体读取经 `laipian-media:`
  受控协议，渲染层拿不到绝对路径。

## 密钥与证书

- **不要**在 Issue、PR、日志或提交中附带密码、Token、签名证书或私钥。
- 正式签名所需的证书/密码只能放在 **GitHub Secrets** 或外部签名服务中。
- 仓库已在 `.gitignore` 排除 `*.pem` / `*.p12` / `*.cer` / `*.pfx` / `*.key` / `.env`。

## 平台安全边界

- 本应用不会要求用户关闭系统安全功能。
- macOS 正式公开发行需要 Developer ID 签名与公证。
- Windows 正式公开发行需要代码签名，否则可能出现 SmartScreen 警告；
  未签名测试包仅供内部验证使用。