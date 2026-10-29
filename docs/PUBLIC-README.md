# 拉片台 CutSpect · 下载与更新

> 本文件给**公开发布仓**使用：那个仓库只放安装包与更新说明，不包含源码。
> 源码在上游开发仓 `ZevinZhao/CutSpect-dev`，以及开发副本 `NinetailedFoxK/CutSpect-dev`。
> 当前源码版本是 `package.json` 的 **0.11.0**。用户下载的安装包以公开发布仓 Releases 上的标签为准。

## 下载

到本仓库 **Releases** 页面，按系统选择：

| 系统 | 文件 |
| --- | --- |
| Windows（x64） | `LaipianTai-<版本>-Windows-x64-Setup.exe` |
| Windows（x64，免安装） | `LaipianTai-<版本>-Windows-x64.zip` |
| macOS（Apple Silicon） | `LaipianTai-<版本>-macOS-arm64.dmg` |
| macOS（Apple Silicon，免安装） | `LaipianTai-<版本>-macOS-arm64.zip` |

普通用户**不需要**安装 Node.js，也不需要安装 Git，更不需要阅读源码。

## 自动更新

- **正式签名**的安装包会在启动后后台检查更新；发现新版本会静默下载，完成后提示
  「稍后 / 立即重启并安装」。
- **未签名或临时签名**的安装包不会静默更新。请下载新的安装包，手动覆盖安装。
  不要为了安装去关闭系统安全功能。
- 更新文件随每个 Release 一起发布：
  - Windows：`RELEASES` 索引与完整 `.nupkg`（自动更新必需，缺一不可）；
  - macOS：包含应用包的 `.zip`。
- 应用内**不含任何 Token**，更新源为本仓库 / Electron 官方托管，无需登录。

## 签名说明（重要）

- 当前发布包为**未签名测试包**：
  - macOS 自动更新需要 Developer ID 签名与公证，当前**不保证自动更新**，
    升级可能需要手动覆盖安装；
  - Windows 未签名时可能出现 SmartScreen 警告。
- 本应用**不会**要求你关闭系统安全功能；请勿为安装而降低系统安全设置。

## 隐私

视频和项目数据留在你的电脑上，不会上传。可选的「检查更新」会联网访问更新服务器。