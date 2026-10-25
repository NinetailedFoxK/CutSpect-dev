# 更新日志（Changelog）

本文件记录面向用户的版本变化。版本号唯一来源是 `package.json`。
安装包请到公开发布仓库的 **Releases** 页面下载；源码开发在私有开发仓库进行。

## v0.10.0（首个公开版本）

### 新增

- **自动更新**：Windows（Squirrel）与 macOS（Squirrel.Mac）内置更新检查与下载。
  启动后后台检查、静默下载，就绪后提示用户「稍后 / 立即重启并安装」；
  无网络或更新失败不会影响应用正常使用。
- Windows 安装包：`LaipianTai-0.10.0-Windows-x64-Setup.exe`（Squirrel）与免安装 ZIP。
- macOS 安装包：`LaipianTai-0.10.0-macOS-arm64.dmg` 与 `.zip`。
- 双系统 CI：macOS 与 Windows 从同一 commit 执行类型检查、测试与构建。

### 已知限制

- **macOS 自动更新需要 Developer ID 签名与公证**。当前为未签名测试包，
  因此**不保证自动更新**（首次升级可能需要手动覆盖安装）。
- Windows 未签名时可能出现 SmartScreen 警告；本应用**不会**要求关闭系统安全功能。
- 目前仅提供 macOS arm64 与 Windows x64。

### 说明

- 普通用户无需安装 Node.js / Git，直接下载对应系统安装包即可。
- 更新源为公开发布仓库 / Electron 官方托管；应用内**不包含任何 GitHub Token**。
- 应用完全离线运行，不联网上传用户素材。