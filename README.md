# 拉片台（laipian-tai / CutSpect）

> **CutSpect / 拉片台 · v0.11.0**（版本号以 `package.json` 为准）
> 本开发副本：[github.com/NinetailedFoxK/CutSpect-dev](https://github.com/NinetailedFoxK/CutSpect-dev)
> 上游开发仓：[github.com/ZevinZhao/CutSpect-dev](https://github.com/ZevinZhao/CutSpect-dev)
> 许可证：[MIT](LICENSE)

桌面拉片（视频分析）应用：一个项目 = 一条视频 + 一条红色分析曲线 + 分段 + 标注。
素材留在本机，不上传。可选的更新检查会联网。

桌面版基于 Electron + React + TypeScript + Electron Forge，采用
**一套共享源码 ＋ 少量平台适配 ＋ macOS 与 Windows 各自构建产物**，
不维护两套业务源码，也不长期保留两个平台分支。

---

## 仓库分别是什么

| 仓库 | 角色 |
| --- | --- |
| `NinetailedFoxK/CutSpect-dev` | 本 fork。在这里改代码、开 PR、跑 CI。 |
| `ZevinZhao/CutSpect-dev` | 上游开发仓。本仓库从它 fork 而来。 |
| 公开发布仓 | 只放安装包、更新说明和更新元数据，不含源码。具体 `owner/repo` 由发布流程的 `RELEASE_REPO` 决定（示例：`ZevinZhao/CutSpect-downloads`）。普通用户从那里的 Releases 下载。 |

本 fork 的 `main` 不是用户下载入口。没有正式发布标签时，不要把这里的源码当成新安装包。

## 一、普通用户：下载与安装

到**公开发布仓**的 Releases 页面，按系统选择：

| 系统 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `LaipianTai-<版本>-macOS-arm64.dmg` | 打开挂载后把「CutSpect」拖入「应用程序」 |
| macOS（Apple Silicon） | `LaipianTai-<版本>-macOS-arm64.zip` | 解压后直接运行 |
| Windows（x64） | `LaipianTai-<版本>-Windows-x64-Setup.exe` | 双击安装，按向导完成 |
| Windows（x64） | `LaipianTai-<版本>-Windows-x64.zip` | 免安装，解压后运行 `laipian-tai.exe` |

> **签名状态（重要）**
> - 当前发布包为**未签名测试包**。macOS 正式公开发行需要 Developer ID 签名与公证；
>   Windows 正式公开发行需要代码签名，否则可能出现 SmartScreen 警告。
> - 本应用**不会**要求你关闭系统安全功能。若被拦截，请以正规渠道获取签名版本，
>   不要降低系统安全设置。
> - 视频和项目数据留在本机，不会上传。可选的「检查更新」会联网访问更新服务器。

FFmpeg 与 ffprobe 随安装包分发，用户**无需另行安装**。

---

## 二、开发者：从源码运行

### 环境要求

- Node.js ≥ 22.12
- macOS 14+ 或 Windows 11 x64
- 依赖以 `package-lock.json` 为准，`npm ci` 可以原样复现安装

### 安装依赖

Electron 二进制体积较大，国内网络建议走镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

镜像失败时回退官方源：`npm install`。锁定安装、以及 CI，使用 `npm ci`（当前 lock 可以原样复现）。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 vite dev（127.0.0.1:5173）与 Electron（HMR 开发） |
| `npm run typecheck` | tsc 全量类型检查（node / web / test / config 四套环境） |
| `npm test` | vitest 运行单元测试 |
| `npm run build:main` / `npm run build:renderer` | 分别构建主进程/preload 与渲染层 |
| `npm run verify` | **提交前自查**：typecheck + 测试 + 构建主进程与渲染层 |
| `npm run package` | 仅执行 Electron Forge 打包（输出 `out/`） |
| `npm run make` | 按当前系统产出安装包（macOS 或 Windows） |
| `npm run make:mac` | 在 macOS 上产出 DMG + ZIP（须在 macOS 执行） |
| `npm run make:win` | 在 Windows 上产出 Setup.exe + ZIP（须在 Windows 执行） |
| `npm run icon:ico` | 由 `assets/icon.iconset` 生成 Windows `assets/icon.ico` |
| `npm run smoke` | 构建后以 `--smoke` 无头模式启动 Electron，截图并自动退出 |

> 构建细节：`sandbox: true` 下沙箱化 preload 无法 `require` 相对路径模块，
> 因此 `build:main` 在 tsc 之后用 esbuild 把 `src/preload/index.ts`
> 打成自包含 CommonJS bundle（`dist/preload/index.js`，仅 external `electron`）。

---

## 三、跨平台架构（共享源码 + 平台适配）

```text
src/
├── shared/      # 主/渲染进程共用：IPC 契约、schema、几何、导出模型、快捷键键位
├── renderer/    # React 界面（两端同一套页面，无 EditorMac/EditorWindows 分叉）
├── main/        # Electron 主进程（Node）：窗口/协议/项目服务/ffmpeg 封装
└── platform/    # 平台适配层（唯一允许按平台分叉的地方）
    ├── common.ts   # PlatformAdapter 接口 + 平台检测/解析（不依赖 DOM/Node 专有 API）
    ├── macos.ts    # macOS 实现：⌘ / 访达 / Homebrew 回退目录
    └── windows.ts  # Windows 实现：Ctrl / 文件资源管理器 / .exe 后缀
```

- `macos.ts` 与 `windows.ts` **实现同一 `PlatformAdapter` 接口**；业务代码只依赖接口。
- 平台差异仅覆盖：主修饰键展示、系统文件管理器名称与「在…中显示」文案、
  可执行文件后缀、开发期 FFmpeg 回退目录。
- **界面、数据模型、快捷键绑定、导出格式完全共用**。
- 项目数据中媒体一律保存**相对路径**（如 `media/source.mp4`，统一正斜杠），
  缓存目录可重新生成，项目可跨平台打开。

### 平台行为对照

| 行为 | macOS | Windows |
| --- | --- | --- |
| 主修饰键 | `⌘`（Command） | `Ctrl` |
| 系统术语 | 「在访达中显示」 | 「在文件资源管理器中显示」 |
| 内部程序名 / 可执行文件 | CutSpect.app | `laipian-tai`（`laipian-tai.exe`） |
| 应用标识 | bundle id `com.cutspec.desktop` | AppUserModelId `com.squirrel.laipian-tai.laipian-tai` |
| 界面显示名 | 「拉片台」（一致） | 「拉片台」（一致） |
| 安装包 | DMG + ZIP（仅 darwin 产出） | Squirrel Setup.exe + ZIP（仅 win32 产出） |

macOS 的 bundle id 和 Windows 的 AppUserModelId **保持各自的值**。Squirrel.Windows 按
`com.squirrel.<安装包名>.<可执行名>` 生成 AppUserModelId（这里两边都是 `laipian-tai`）。
把它改成 `com.cutspec.desktop` 会让任务栏归组、快捷方式和更新安装对不上。

快捷键在两端的绑定完全共用（`mod` 在 macOS 映射 Command、Windows 映射 Ctrl）；
`Control + 滚轮` 缩放时间线、`Shift + 滚轮` 横向移动，`Space`/`J K L`/方向键/`Q W E`/
`R G`/`V`/`1 2 3` 等键位一致。

---

## 四、目录结构

```text
├── index.html                 # 渲染层入口（含 CSP meta）
├── forge.config.ts            # Electron Forge 打包（平台条件化 makers）
├── vite.config.ts             # 渲染层构建（base './'，输出 dist/renderer）
├── vitest.config.ts           # 测试配置（node 环境）
├── assets/                    # icon.icns（macOS）/ icon.ico（Windows）同源图标
├── .github/workflows/         # ci.yml（双系统检查）/ release.yml（双系统发布）
├── docs/                      # 产品规格
└── src/                       # shared / renderer / main / platform（见上）
```

## 五、IPC 契约

renderer 只通过 `window.laipian`（preload 注入）访问主进程能力，
全部方法与类型定义在 `src/shared/api-types.ts`：

- 统一返回 `Result<T>`（`ok/data` 或 `ok:false/error:{code,message,retryable}`）。
- 文件选择入口 `dialog.pickVideoFile / pickProjectDir / pickOpenProjectFolder`
  返回**一次性 opaque 令牌**，真实路径不进入渲染层。
- `projects.*`、`tasks.*`、`media.*`、`exports.*`、`settings.*`、`updates.*` 已接入真实服务。

## 六、安全基线

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- 阻止远程导航与新窗口；CSP 经 `index.html` meta 设置。
- `laipian-media:` 注册为 standard+stream 协议，URL 只含 `projectId/mediaId/kind`，
  真实路径登记在 main 侧注册表（未注册 → 403），支持 GET/HEAD + Range。
- 单实例锁 + 项目级 `.lock`；preload 不暴露 fs/shell/ipcRenderer 本体。
- IPC 来源白名单（仅本应用渲染层）+ zod 参数校验。
- 原子保存（同目录临时文件 → fsync → rename），并对 Windows 的
  `EPERM`/`EACCES`/`EBUSY` 做有限重试。

## 七、仓库隔离（私有开发仓库 / 公开发布仓库）

- **私有开发仓库**：源码、测试、CI、发布配置与完整 Git 历史。
- **公开发布仓库**：只放 README、更新说明、安装包与更新元数据；**不含任何源码**。
- 发布由私有仓库 `release.yml` 跨仓库推送到公开仓库的 Release，
  使用 `RELEASE_REPO`（Variables）与 `RELEASE_REPO_TOKEN`（Secrets，最小权限）。
- `out/`、DMG、EXE、ZIP、`build/` 等构建产物**不入库**（见 `.gitignore`）。

## 八、持续集成与发布

- **ci.yml**：`push` 与 `Pull Request` 时，在 macOS 与 Windows **两个环境**
  从**同一 commit**分别执行 `npm ci`、类型检查、测试与构建；任一端失败即视为未完成。
  当前 `package-lock.json` 可以被 `npm ci` 原样安装。
- **release.yml**：推送 `v*` 标签触发；macOS 产出 DMG + ZIP，Windows 产出
  Setup.exe + ZIP + `RELEASES` + `.nupkg`（自动更新必需），全部上传到
  **公开发布仓库**的同一个 Release。
- 版本号唯一来源是 `package.json`（当前 **0.11.0**）；一个版本只用一个标签（如 `v0.11.0`），
  发布前校验「标签版本 = package.json 版本」。

## 九、自动更新

- 机制：Electron 内置 `autoUpdater`（Windows = Squirrel，macOS = Squirrel.Mac）；
  不引入第三方更新方案，**应用内不含任何 GitHub Token**。
- 正式签名包的流程：启动 → 延迟后台检查 → 无更新不打扰 / 有更新静默下载 →
  就绪后提示「稍后 / 立即重启并安装」；安装前先保存当前项目。
- 更新地址集中配置（唯一入口 `src/shared/update.ts` 的 `resolveUpdateConfig`）：
  构建时由 `scripts/write-update-config.cjs` 把公开仓库名注入
  `resources/update-config.json`；开发环境、未配置或未签名时自动禁用更新。
- **未签名和 ad-hoc 构建禁用静默更新。** 当前 macOS 打包钩子是 `codesign --sign -`
  （本机临时签名），Windows 打包也不做 Authenticode。这类安装包不会在后台下载并替换自己。
  升级时请到公开发布仓下载新安装包，手动覆盖安装。不要为了安装去关闭系统安全功能。
- 只有使用 Developer ID（macOS）或 Authenticode（Windows）正式签名的发布构建，
  才应在构建时设置 `LAIPIAN_UPDATE_SIGNED=1`。该标记写进 `update-config.json`。
  运行时环境变量**不能**把未签名包重新打开自动更新。
- 可用环境变量：`LAIPIAN_RELEASE_REPO`（公开仓库 owner/repo）、
  `LAIPIAN_UPDATE_FEED`（自建 feed，可选）、`LAIPIAN_UPDATE_DISABLE`（彻底关闭）、
  `LAIPIAN_UPDATE_SIGNED`（仅正式签名的构建机）。

## 十、浏览器预览模式

`npm run dev:renderer` 单独启动 vite 后用浏览器打开 `http://127.0.0.1:5173`
可预览 UI：检测不到 `window.laipian` 时显示“浏览器预览模式”横幅且不崩溃。
此模式仅供 UI 开发，不是产品功能。

## 十一、已知边界

- **签名**：macOS 正式公开发行需 Developer ID 签名与公证；Windows 正式发行需
  代码签名。当前打包结果是未签名或 ad-hoc 测试包，静默自动更新已关闭。
- **手动升级**：未签名 / ad-hoc 包请下载新安装包覆盖安装。Windows 未签名时可能出现
  SmartScreen 警告。本应用不会要求关闭系统安全功能。
- `src/platform/linux.ts` 不存在：Linux 目前仅复用 Windows 适配（未验证回退）。
- 部分真实设备项（Apple Silicon 之外架构、125%/150% 缩放观感、真实指针手势、
  PNG Canvas 光栅化）仍建议在真机做专项验收。

## 十二、参与贡献

- 贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请见 [SECURITY.md](SECURITY.md)（不要用公开 Issue 披露漏洞）。
- 许可证：[MIT](LICENSE)。