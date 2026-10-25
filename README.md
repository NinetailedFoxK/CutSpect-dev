# 拉片台（laipian-tai）

> **CutSpect / 拉片台 · v0.10.0**  
> 开源仓库：[github.com/ZevinZhao/CutSpect](https://github.com/ZevinZhao/CutSpect)

离线桌面拉片（视频分析）应用：一个项目 = 一条视频 + 一条红色分析曲线 + 分段 + 标注。

当前进度：**阶段 A（桌面 / 真实媒体 / 保存与重开）、阶段 B（曲线核心）、阶段 C 主体
（标注 / 分段 / 项目库 / 自动保存）、阶段 D 大部分（PNG / Markdown 导出、恢复快照、
素材重定位、缩略图与封面、兼容副本 WebM/VP8/Opus）已实现并实测通过**；
macOS Apple Silicon `.app` / ZIP / DMG 已构建，FFmpeg 与 ffprobe 已随应用分发。
**真实窗口指针手势**、**PNG Canvas 光栅化**、**导入策略页自动触发兼容副本**和
**性能测量**仍待专项验证。
《继续优化需求文档 v1.1》**P0：时间线视频帧带 + 曲线节点与精确画面帧联动**、
**P1：快捷键系统 + 速查面板 + 用户自定义**均已实现（324 测试通过；开发构建冒烟包含
帧带/精确帧/快捷键设置探针）。快捷键可在“快捷键”面板（顶栏入口或 `?`）内点击键位
后按下新组合改键，冲突即时提示，全局保存于 `userData/settings.json`。
另已实现**智能识别镜头（硬切检测）**：时间线附近“智能识别镜头”按钮 → 三档灵敏度
（保守 14 / 标准 10 / 灵敏 8）+ 最短镜头长度 → 后台用内置 FFmpeg `scdet` 检测 → 时间线
显示候选分割线（可逐条删除）→ “应用结果”才转正式分段并命名「镜头 001…」，可一次撤销；
检测只写 `cache/shots/`，不改 `project.json`。
编辑器**右侧栏为常驻固定显示**：属性区在上、列表固定在下（均自行滚动），不再需要手动展开。
快捷键支持**滚轮手势**：可把「滚轮缩放/平移时间线」绑成 `Alt+滚轮`、`⌃(Ctrl)+滚轮` 等（中键滚动同效），录制时直接滚动滚轮即可。
详见仓库根目录 `IMPLEMENTATION_STATUS.md`（逐条验收状态与阻塞项）。

规格文档见 `docs/spec/拉片台_MVP开发文档_v1.0.md`（重点第 2、11、12、17 节）。

## 开发环境要求

- Node.js ≥ 22.12（本仓库在 Node 25.5.0 / npm 11.8.0 上验证）
- macOS 14+ 或 Windows 11 x64
- 所有依赖版本精确锁定（无 `^`/`latest`），构建可重复

## 安装

Electron 二进制体积较大，国内网络建议走镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

镜像失败时回退官方源：`npm install`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 vite dev（127.0.0.1:5173）与 Electron（HMR 开发） |
| `npm run typecheck` | tsc --noEmit 全量类型检查（node / web / config 三套环境） |
| `npm test` | vitest 运行单元测试（shared 纯函数与契约冒烟） |
| `npm run build` | 类型检查 → 编译主进程+打包 preload → vite 构建渲染层 → Forge 打包 |
| `npm run smoke` | 构建后以 `--smoke` 无头模式启动 Electron，截图并自动退出 |
| `npm run package` | 仅执行 Electron Forge 打包（输出 `out/`） |
| `npm run make` | Forge 产出 macOS ZIP 与 DMG，并执行本机临时签名 |

> 构建细节：`sandbox: true` 下沙箱化 preload 无法 `require` 相对路径模块，
> 因此 `build:main` 在 tsc 之后用 esbuild 把 `src/preload/index.ts`
> 打成自包含 CommonJS bundle（`dist/preload/index.js`，仅 external `electron`）。

## 目录结构

```text
├── index.html                 # 渲染层入口（含 CSP meta）
├── forge.config.ts            # Electron Forge 打包配置
├── vite.config.ts             # 渲染层构建（base './'，输出 dist/renderer）
├── vitest.config.ts           # 测试配置（node 环境）
├── tsconfig(.node/.web/.test/.config).json  # 四套互不混用的 TS 环境
├── docs/spec/                 # 产品规格
├── src/
│   ├── main/                  # Electron 主进程（Node 环境）
│   │   ├── main.ts            # 窗口/安全基线/单实例锁/媒体协议注册/smoke
│   │   ├── ipc.ts             # IPC handler（来源校验 + zod + 真实服务接线）
│   │   ├── protocol.ts        # laipian-media: 安全流式协议（Range/206/416）
│   │   ├── file-selection.ts  # 文件选择令牌注册表（一次性兑换）
│   │   └── services/          # project-service（含恢复快照/重定位）/ media-service /
│   │                          # ffmpeg / tasks / recent-store / atomic-write /
│   │                          # export-service / thumbnail-service /
│   │                          # compatible-copy-service / errors
│   ├── preload/index.ts       # contextBridge 窄接口桥（window.laipian）
│   ├── renderer/              # React 渲染层（DOM 环境）
│   │   ├── App.tsx            # 页面状态机 + 工作台保存管线
│   │   ├── pages/             # Home（项目库）/ ImportPage / Editor
│   │   ├── components/        # VideoCanvas / CurveLayer / Timeline / PlayerBar / 对话框
│   │   ├── export/            # render-png（Canvas 光栅化）
│   │   ├── hooks/             # useMediaPlayer / useRecentProjects …
│   │   └── editor/            # editor-geometry / timeline-math / playhead-store / tools
│   └── shared/                # 主/渲染进程共享
│       ├── api-types.ts       # ★ IPC 契约（Result/LaipianApi/ProjectSnapshot…）
│       ├── schema.ts          # zod 结构契约 + 不变量校验 + 初始快照工厂
│       ├── geometry.ts        # 曲线几何核心（求值/插值/贝塞尔/局部替换/夹紧）
│       ├── annotations.ts     # 标注数据操作（唯一性/修改/标题退避）
│       ├── sections.ts        # 分段数据操作（分割/夹紧/锁定/合并/归属）
│       ├── export-markdown.ts # Markdown 分析笔记生成（含转义与归属）
│       ├── export-png.ts      # PNG 导出模型（坐标/刻度/编号/索引）
│       ├── history.ts         # 内容撤销/重做（快照式，500ms 合并，上限 100）
│       ├── media-url.ts       # laipian-media: URL 构造（两侧共用）
│       ├── ipc-channels.ts    # 通道名常量（preload 与 main 共用）
│       └── time.ts            # 时间格式化/夹紧纯函数
└── tests/                     # 23 个测试文件（含真实 ffprobe/ffmpeg、保存并发、曲线/标注/分段、导出、恢复与转换）
```

## IPC 契约

renderer 只通过 `window.laipian`（preload 注入）访问主进程能力，
全部方法与类型定义在 `src/shared/api-types.ts`（规格 12.4）：

- 统一返回 `Result<T>`（`ok/data` 或 `ok:false/error:{code,message,retryable}`）
- 文件选择入口 `dialog.pickVideoFile / pickProjectDir / pickOpenProjectFolder`
  返回**一次性 opaque 令牌**，真实路径不进入渲染层
- `projects.*`（listRecent/create/open/openRecent/rename/save/listBackups/
  restoreBackup/removeRecent/reveal/close）与 `tasks.*`（subscribe/snapshot/cancel）
  **已接入真实服务**
- `media.createCompatibleCopy / rebuildThumbnails / probe` 与 `exports.save`
  均已接入真实服务

## 安全基线（规格 12.5）

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- 阻止远程导航与新窗口；CSP 经 `index.html` meta 设置
  （`default-src 'self'`；`media-src`/`img-src` 放行 `laipian-media:`）
- `laipian-media:` 注册为 standard+stream 协议，URL 只含 `projectId/mediaId/kind`，
  真实路径登记在 main 侧注册表（未注册 → 403），支持 GET/HEAD + Range
- 单实例锁 + 项目级 `.lock`（陈旧锁可接管）；preload 不暴露 fs/shell/ipcRenderer 本体
- IPC 来源白名单（仅本应用渲染层）+ zod 参数校验

## 浏览器预览模式

`npm run dev:renderer` 单独启动 vite 后用浏览器打开
`http://127.0.0.1:5173` 可预览 UI：页面检测不到 `window.laipian` 时
显示“浏览器预览模式”横幅且不崩溃。此模式仅供 UI 开发，不是产品功能。

## 已知边界

- 真实窗口指针手势与 PNG Canvas 光栅化未做自动化验证；导入策略页自动触发兼容副本与性能测量尚未完成
- macOS Apple Silicon 包含 FFmpeg 6.0 与 ffprobe 4.4.1，不依赖用户另行安装
- macOS 产物使用本机临时签名，未使用 Developer ID、未公证，不适合作为公开下载发行包
- Windows x64、macOS x64（Intel）未构建/未验证
