# AGENTS.md — CutSpect / 拉片台 项目协作规则

> 本文件是本仓库**所有 AI 开发工作的长期规则**，不是一次性任务提示。
> 在仓库中开始任何任务前，必须先读取并遵守本文件。
>
> 相关文件：`README.md`（下载与开发说明）、`CONTRIBUTING.md`（贡献指南）、
> `SECURITY.md`（安全策略）。它们与本文件并行生效；若出现冲突，**以本文件为准**。

---

## 0. AI 读取与遵守方式（给使用者）

- 显式方式：在对话首条消息中写一句「请先读取并遵守根目录 `AGENTS.md`」。
- 隐式方式：把本文件保留在仓库根目录 `AGENTS.md`，支持该约定的智能体启动时会自动加载。
- 优先级：**项目级 `AGENTS.md` > 用户级全局规则 > 通用默认行为**。
- 若任务涉及具体文件，AI 应在动手前先阅读 `README.md`、`CONTRIBUTING.md` 与本文件，
  并阅读任务相关的源码与测试。

---

## 一、项目背景

- 项目名称：**CutSpect / 拉片台**。
- 仓库地址：`https://github.com/ZevinZhao/CutSpect`
- 技术形态：Electron + React + TypeScript，Windows / macOS 双平台桌面应用。

项目有两类使用对象：

1. **项目开发者**
   - 在 Windows 与 macOS 两台电脑上持续开发；
   - 通过 GitHub 同步代码；
   - 使用功能分支、Pull Request 与双系统 CI 管理开发；
   - 由 GitHub Actions 构建 Windows 与 macOS 安装包。
2. **普通用户**
   - 不需要安装 Node.js，不需要安装 Git，不需要阅读源码；
   - 只从 GitHub Releases 下载对应系统的安装包；
   - Windows 下载 `Setup.exe`，macOS 下载 `DMG` 或 `ZIP`。

开发入口与用户下载入口分开，但**不必拆成两个仓库**：

- GitHub **Code** → 源码开发；
- GitHub **Actions** → 自动检查与构建；
- GitHub **Releases** → 普通用户下载安装包。

---

## 二、核心架构原则

架构固定为：

```text
一套共享业务源码
+
少量 Windows/macOS 平台适配
+
两个系统分别构建安装包
```

必须遵守：

- Windows 与 macOS 使用**同一套业务源码**；
- **不创建**长期的 Windows 分支或 macOS 分支；
- **不复制**两套完整项目；
- **不创建** `EditorWindows`、`EditorMac` 这类两套业务页面；
- 通用业务代码优先放在：`src/renderer`、`src/shared`、`src/main`；
- 真正的平台差异放在：`src/platform/common.ts`、`src/platform/windows.ts`、`src/platform/macos.ts`；
- Windows 与 macOS 的平台实现必须遵守**同一个接口**；
- 禁止在业务组件中硬编码：`Finder`、`文件资源管理器`、`Command`、`Ctrl`、Windows 路径、macOS 路径；
- 平台差异应通过**适配层、统一接口或平台配置**解决；
- 项目数据必须保存**相对路径**，例如 `media/source.mp4`、`cache/thumbs/001.jpg`；
- 禁止把以下内容写入项目数据：`C:\Users\...`、`/Users/...`、当前电脑用户名、
  当前电脑固定目录、当前电脑临时路径。

---

## 三、两台电脑的长期开发管理

Windows 与 macOS 是两个**开发环境**，不是两个独立项目。**GitHub 是唯一的远程事实来源。**

离开一台电脑前：

1. 保存当前代码；2. 检查 Git 状态；3. 提交当前阶段；4. 推送到 GitHub；5. 记录当前分支与 commit。

在另一台电脑开始前：

1. 检查本地是否有未提交修改；2. 获取 GitHub 最新状态；3. 确认当前分支；4. 拉取正确分支；
5. 确认两台电脑处于**同一个 commit**；6. 安装依赖；7. 运行项目验证；8. 再开始修改。

- 不要通过微信、网盘或复制整个文件夹同步项目。
- 不同步以下本地生成内容：`node_modules`、`dist`、`out`、本地日志、临时缓存、个人测试素材。
- 两台电脑使用相同的：GitHub 仓库、分支、commit、Node.js 主版本、`package.json`、`package-lock.json`。

---

## 四、Git 分支规则

- `main` 是稳定主分支，代表可继续交付或发布的代码。
- **不要直接在 `main` 上开发功能。**
- 功能与修复使用短期分支：`feat/功能名称`、`fix/问题名称`、`chore/维护内容`。
  例如：`feat/project-search`、`feat/export-report`、`fix/windows-ffmpeg-path`、
  `fix/macos-file-reveal`、`chore/update-ci`。
- 流程：

```text
main → 功能分支 → 本地开发和测试 → 推送到 GitHub → Pull Request → Windows/macOS CI → 合并到 main
```

- **不要**创建长期存在的 `windows`、`macos`、`development` 这类系统分支。
- 如果当前工作区存在未提交修改：
  - 不要覆盖；不要删除；
  - 不要执行 `git reset --hard`；不要执行 `git clean -fd`；
  - 不要自动切换分支；不要自动合并；
  - 先报告现状，并判断这些修改是否属于当前任务。

---

## 五、AI 开始工作前的固定行为

每次开始任何开发任务前，必须先检查：

```text
当前路径 / 当前分支 / 当前 commit / 远程仓库 / Git 工作区状态 /
是否落后于远程 / package.json 版本 / Node.js 版本 / npm 版本
```

重点命令：

```bash
git status
git branch -vv
git remote -v
git log -1 --oneline
node --version
npm --version
```

- 发现未提交修改 → **必须先报告**，不能直接覆盖。
- 当前分支不是预期分支 → **必须先报告**。
- 本地与远程分叉 → **必须先解释风险**，不能直接强制合并或重置。
- 环境缺少上述命令（例如未安装 Git / Node 不在 PATH）→ **如实说明无法检查，不得假装已检查**。

---

## 六、AI 的开发行为

**应该：**

- 先阅读 `README.md`、`CONTRIBUTING.md` 与任务相关源码与测试；
- 先说明问题原因与实现方案，再开始修改；
- 只修改当前任务需要的文件；
- 保留与当前任务无关的用户修改；
- 为重要逻辑补充测试；
- 优先使用已有接口与服务；
- 保持跨平台兼容；
- 说明 Windows 与 macOS 分别需要验证什么。

**不应该：**

- 凭文件名猜测架构；
- 为小功能大规模重构；
- 删除测试来掩盖失败；
- 降低断言来制造假通过；
- 把个人电脑配置写入源码；
- 把密码、Token、API Key 或证书上传到仓库；
- 修改与任务无关的文件；
- 把多个不相关功能混成一个提交。

---

## 七、依赖与生成文件规则

**必须提交**：源代码、测试、文档、CI 配置、发布配置、`package.json`、`package-lock.json`、
必要的图标与构建脚本。

**禁止提交**：

```text
node_modules
dist
out
本地日志
临时目录
个人测试视频
系统缓存
.env
密钥
证书
API Key
Token
密码
```

- 如果 `package-lock.json` 发生变化，**必须说明原因**。
- 如果发现疑似敏感信息，**立即停止上传并报告**。

---

## 八、验证规则

修改后按任务运行验证。

常规验证：

```bash
npm run typecheck
npm test
npm run build:main
npm run build:renderer
```

完整验证：

```bash
npm run verify
```

打包：

```bash
npm run make:win   # Windows：Setup.exe + ZIP（须在 Windows 环境执行）
npm run make:mac   # macOS：DMG + ZIP（须在 macOS 环境执行）
```

涉及双系统的改动，必须**分平台报告**：

```text
Windows 已验证：
macOS 已验证：
需要另一台电脑补充验证：
```

如果测试失败：

- 不要声称验证通过；
- 说明失败的测试；
- 判断是代码问题、环境问题、平台问题还是缺失测试素材；
- 优先修复；若暂时无法修复，明确标记为**未完成**。

---

## 九、提交与上传规则

默认情况下，AI 可以分析、修改和测试，但**不要擅自提交或推送**。

- 只有用户明确表达「提交 / 保存到 Git / 创建 commit / 把当前进度保存下来」时，才执行提交。
- 只有用户明确表达「上传到 GitHub / 推送 / 同步到远程 / 把当前分支传上去」时，才执行推送。

提交前必须检查：

```bash
git diff --check
git status
git diff --stat
git diff --cached --stat
```

提交前必须报告：当前分支、将要提交的文件、不会提交的文件、测试结果、建议的提交信息。

提交信息格式：

```text
feat: add project search
fix: resolve Windows ffmpeg path
fix: handle missing media file
chore: improve cross-platform CI
```

如果测试失败：

- 默认先修复；
- 若用户明确说「先上传当前进度」，可以创建 WIP 提交；
- WIP 提交信息必须明确包含 `WIP`；
- **不得**把失败状态描述为成功。

推送时：

- 默认只推送当前功能分支；
- 不要直接推送 `main`；不要强制推送；
- 推送完成后报告：分支名称、commit SHA、GitHub 分支地址、CI 状态、已知失败。

---

## 十、禁止自动执行的高风险 Git 操作

除非用户明确授权，否则禁止：

```text
git reset --hard
git clean -fd
git push --force
删除本地分支
删除远程分支
直接推送 main
合并 Pull Request
创建版本标签
创建 GitHub Release
发布安装包
修改仓库权限
上传密钥或证书
```

必须执行其中任何操作时，要先解释影响并请求确认。

---

## 十一、Pull Request 规则

允许在用户要求时创建 Pull Request，但**不要自动合并**。

Pull Request 描述必须包含：

```text
本次解决的问题
主要修改
测试结果
Windows 验证结果
macOS 验证结果
已知问题
是否涉及数据格式
是否涉及安装包
```

只有以下条件满足时才建议合并：

- Windows CI 通过；macOS CI 通过；
- 相关测试通过；没有未解释的失败；
- 没有敏感文件；改动范围与需求一致。

---

## 十二、版本发布与用户下载规则

普通用户**不应**下载源码，也不应运行 npm 命令。用户从 GitHub Releases 下载：

```text
Windows：Setup.exe
macOS：DMG 或 ZIP
```

正式发布流程：

```text
功能分支 → Pull Request → Windows/macOS CI 通过 → 合并 main →
更新 package.json 版本 → 更新变更说明 → 创建 v* 标签 →
GitHub Actions 构建 Windows/macOS 安装包 → GitHub Release
```

版本号统一管理：`v0.10.1`、`v0.11.0`、`v1.0.0`；测试版如 `v0.11.0-beta.1`。
版本号**唯一来源**是 `package.json`，一个版本只用一个标签。

没有用户明确说「发布 / 创建版本 / 生成正式安装包」时，不要：

- 修改正式版本号；创建标签；创建 Release；发布安装包；宣称用户可以下载新版本。

---

## 十三、AI 的沟通方式

使用者是一名中国科技自媒体从业者，熟悉 AI、AIGC 与前沿科技，能理解技术细节，
但希望重要决策讲清楚依据。协作时：

- 先给结论，再解释原因；
- 不要只输出命令；
- 说明每一步会改变什么；
- 发现风险时直接指出；
- 复杂问题用具体例子说明；
- 涉及能力成长时采用教练方式；
- 需要交付时优先完成结果；
- 不要用空泛表扬；
- 不要把不确定的内容说成确定事实；
- 不要隐藏测试失败、上传失败或权限问题。

---

## 十四、每次任务结束时的报告格式

任务完成后必须按以下格式报告：

```text
任务结果：
- ...

修改内容：
- ...

修改文件：
- ...

验证结果：
- typecheck：
- 单元测试：
- 主进程构建：
- 渲染层构建：
- Windows 验证：
- macOS 验证：

Git 状态：
- 当前分支：
- 当前 commit：
- 是否有未提交修改：

GitHub 状态：
- 是否已提交：
- 是否已推送：
- 远程分支：
- commit SHA：
- Pull Request：
- CI 状态：

仍需处理：
- ...
```