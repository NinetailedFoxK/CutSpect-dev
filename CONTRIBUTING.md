# 贡献指南（Contributing）

感谢参与「拉片台 / CutSpect」。本项目是**一套共享源码 + 少量平台适配 + macOS/Windows
各自构建产物**：禁止复制出两套完整项目，也不要长期维护两个业务分支。

## 基本原则

- 主业务代码（`src/renderer/`、`src/shared/`、绝大多数 `src/main/`）由 macOS 与 Windows 共用。
- 只有**真正不同的系统行为**才进入 `src/platform/`（`common.ts` / `macos.ts` / `windows.ts`），
  且 `macos.ts` 与 `windows.ts` **必须实现同一 `PlatformAdapter` 接口**。
- 不允许新增 `EditorMac.tsx` / `EditorWindows.tsx` 这类平台分叉页面。
- 项目文件、曲线、节点、标注、三级结构、快捷键与导出数据必须跨平台兼容；
  不允许把 macOS/Windows 绝对路径写入项目数据（项目内媒体一律用 `media/…` 相对路径）。

## 开发环境

- Node.js ≥ 22.12，macOS 14+ 或 Windows 11 x64。
- 安装依赖（国内网络建议走镜像）：

  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
  ```

## 提交前自查

请在本机跑一遍（两端行为一致）：

```bash
npm run verify        # typecheck + 单元测试 + 构建主进程/渲染层
```

- 修改了平台行为时，请分别说明 macOS 与 Windows 的差异。
- 新增用户可见文案涉及系统术语时，使用 `src/platform` 的适配值
  （如文件管理器名称、主修饰键展示），不要在组件里硬编码 `⌘` / `Finder`。
- 涉及 FFmpeg / ffprobe / 文件路径 / 快捷键 / 导出 的改动，请在 PR 说明中注明
  是否已在真实 Windows 与 macOS 环境验证。

## 打包

- macOS：`npm run make:mac` → `out/make/` 生成 DMG 与 ZIP。
- Windows：`npm run make:win` → 生成 Squirrel `Setup.exe` 与 ZIP。
  **Windows 安装包必须在真实 Windows 环境生成**，不能仅靠 macOS 交叉打包宣称完成。
- 版本号唯一来源是 `package.json`；发布使用单个标签（如 `v0.10.0`）。

## 拉取请求

- 保持改动聚焦、可审阅；PR 描述请填写 `.github/pull_request_template.md`。
- CI（`.github/workflows/ci.yml`）会在 macOS 与 Windows 上从同一 commit 构建；
  两端都通过才算完成。

## 许可证

提交即表示你同意你的贡献以本仓库的 [MIT 许可证](LICENSE) 发布。