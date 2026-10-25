# 拉片台 实施状态（IMPLEMENTATION_STATUS）

> 本文件按规格第 17 节要求维护：每个需求的状态、实现位置、验证方式、平台结果、已知问题。
> 状态用词严格区分：
> - **已实现**：代码存在且接线到真实路径。
> - **已实测**：有可复现证据（自动化测试 / 安装包运行记录 / 截图）。
> - **未验证**：代码可能存在但当前机器无法验证（缺平台 / 缺证书 / 缺素材）。
> - **阻塞项**：缺少外部条件（证书、目标系统、FFmpeg 二进制）才能继续。
>
> 最后更新：2026-10-24。更新者：实施记录（阶段 A/B/C + 阶段 D：导出 / 恢复快照 / 素材重定位 / 缩略图 / 兼容副本）。

## 0. 验证环境与证据

| 项 | 值 |
|---|---|
| 验证机器 | macOS（Apple Silicon，darwin arm64），GUI 会话 |
| Node / npm | 25.5.0 / 11.8.0 |
| Electron | 44.9.3 |
| FFmpeg / ffprobe | 随包分发：FFmpeg 6.0 / ffprobe 4.4.1（macOS arm64） |
| 类型检查 | `npm run typecheck` 通过（node / web / test / config 四套 tsconfig） |
| 单元/集成测试 | `npm test` → **259 passed / 23 files** |
| 端到端冒烟 | `npm run smoke` → `SMOKE_OK`（真实 Electron 窗口 + IPC 往返 + 真实媒体协议加载与 seek） |
| 打包 | `.app`、ZIP、DMG 已成功生成；应用完整性签名校验通过；打包后应用冒烟 `SMOKE_OK`；已安装至 `/Applications/拉片台.app` |

冒烟证据摘录：
```
[smoke] ipc probe: {"stage":"ok","hasDialog":true,"hasSubscribe":true,"hasOpenRecent":true,"recentOk":true}
[smoke] media probe: {"ok":true,"stage":"ready","duration":10,"seekedTime":2}
[smoke] SMOKE_OK
```
即：`window.laipian` 注入成功；`projects.listRecent` 真实返回数组；渲染层经 `laipian-media://smoketest/media/source` 加载真实 H.264 视频、读到时长 10s、seek 到 2s 成功（验证协议 + Range）。

## 1. 阶段总表（规格 17）

| 阶段 | 目标 | 状态 |
|---|---|---|
| A 桌面与真实媒体骨架 | 工程配置、原生文件选择、创建项目文件夹、复制源视频、ffprobe、真实播放、安全媒体读取、保存和重开 | **已实现 + 已实测**（macOS arm64） |
| B 曲线核心 | 统一坐标、SVG 叠加、图层控制、节点/直线/平滑/贝塞尔/自由画/局部替换/多选/撤销重做/缩放平移 | **已实现 + 已实测（逻辑/渲染/持久化）**；**指针手势真实窗口手感未验证** |
| C 完整分析工作流 | 标注、分段、项目库搜索重命名、自动保存与恢复、缺失素材重定位 | **已实现 + 已实测**（真实窗口指针手势除外） |
| D 兼容、输出与稳定 | 兼容副本、后台任务取消、缩略图、PNG/Markdown 导出、打包签名、性能测试 | **大部分已实现 + 已实测**；性能压力和公开发行签名/公证未完成 |

## 2. 阶段 A 明细（闭环）

| 需求 | 状态 | 实现位置 | 验证 |
|---|---|---|---|
| 原生视频/目录选择 + 一次性令牌 | 已实现/已实测 | `src/main/ipc.ts`, `src/main/file-selection.ts` | 冒烟 `hasDialog:true` |
| 创建项目文件夹（名称过滤 + 短 UUID） | 已实现/已实测 | `project-service.sanitizeFolderName`, `uniqueFolder` | `tests/project-service.test.ts`（含非法字符/保留名/超长） |
| 流式复制 + SHA-256（不整读内存） | 已实现/已实测 | `media-service.copyWithHash` | `tests/media.test.ts`、真实媒体测试 SHA 比对 |
| ffprobe 探测（时长/编码/帧率/HDR/VFR） | 已实现/已实测 | `services/ffmpeg.ts` | `tests/project-service-real-media.test.ts`（真实 ffprobe） |
| 容量基线判定（≤20GB/≤2h/1080p/30fps） | 已实现/已实测 | `media-service.checkMediaPolicy` | 测试：超 2h 被拒绝且清理临时目录 |
| 原子写 project.json | 已实现/已实测 | `services/atomic-write.ts` | 测试：坏数据被拒后磁盘原文不变 |
| revision 乐观锁 | 已实现/已实测 | `project-service.saveProject` | 测试：过期 revision → `REVISION_CONFLICT` |
| 备份保留最近 5 份 | 已实现/已实测 | `project-service.backupCurrent/pruneBackups` | 测试：连续 7 次保存 → ≤5 份 |
| 项目锁（跨进程、陈旧锁接管） | 已实现/已实测 | `project-service.acquireLock` | 测试：存活 pid 锁 → `PROJECT_LOCKED` |
| 最近项目索引（userData） | 已实现/已实测 | `services/recent-store.ts` | `tests/project-service.test.ts` |
| 安全媒体读取（协议 + Range/206/416） | 已实现/已实测 | `main/protocol.ts`, `main.ts` 注册 | `tests/protocol.test.ts`（35 例）+ 冒烟真实 seek |
| 真实视频播放（媒体时间驱动播放头） | 已实现/已实测 | `renderer/hooks/useMediaPlayer.ts`, `VideoCanvas` | 冒烟：loadedmetadata + seeked |
| 保存 / 重开闭环 | 已实现/已实测 | `App.EditorHost` + `projects.save/openRecent` | 自动化 + 冒烟 IPC |
| 关闭释放锁与媒体注册 | 已实现/已实测 | `project-service.closeProject` + `main before-quit` | 测试：close 后 `.lock` 消失 |

阶段 A **完成条件**核对：
- 非开发电脑导入基线视频并播放：**部分已实测**（本机冒烟用真实素材验证了“经协议加载 + seek 播放”）；**安装包在非开发机运行未验证**。
- 关闭重开仍能找到视频：**已实测**（自动化 `create → openRecent`）。
- 资源读取支持 seek：**已实测**（`tests/protocol.test.ts` 的 206/416 用例 + 冒烟真实 seek）。

## 3. 阶段 B 明细（曲线核心）

| 需求 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 统一时间坐标映射（time↔x、value↔y、缩放平移） | 已实现/已实测 | `renderer/editor/editor-geometry.ts`, `shared/time.ts` | `tests/editor-skeleton.test.ts`（B01/B02 的几何基础） |
| 曲线求值：linear / auto（形状保持单调三次）/ bezier（按时间反解） | 已实现/已实测 | `shared/geometry.ts` | `tests/geometry.test.ts`（含无过冲、反解 X(u)=t） |
| 红色曲线绘制到画布（与网格/时间线同一坐标系） | 已实现/已实测（渲染） | `renderer/components/CurveLayer.tsx`, `VideoCanvas.tsx` | `tests/curve-layer.test.tsx`（SSR 断言坐标映射） |
| 节点插入（等形分割）/ 删除 / 多节点统一夹紧移动 | 已实现/已实测 | `shared/geometry.ts` | `tests/geometry.test.ts` |
| 段模式切换（自动平滑 / 直线 / 贝塞尔等形转换） | 已实现/已实测 | `shared/geometry.ts#setSegmentOutMode` | `tests/geometry.test.ts` |
| 贝塞尔控制柄约束（x0≤c1x≤c2x≤x1、纵值 0—100） | 已实现/已实测 | `shared/geometry.ts#clampAllHandles` | `tests/geometry.test.ts` |
| 自由画 / 直线：仅替换 [start,end]、区间外原形保留、端点连续 | 已实现/已实测 | `shared/geometry.ts#replaceRange` | `tests/geometry.test.ts`（区间外不变、边界连续） |
| 多选 / 框选 / 整笔撤销重做（history） | 已实现/已实测（逻辑） | `shared/history.ts`, `tools.ts`, `CurveLayer.tsx` | `tests/history.test.ts`、`tests/tools.test.ts` |
| 工具状态机与快捷键（V/P/B/L；M/S 阶段 C） | 已实现/已实测 | `renderer/editor/tools.ts`, `Editor.tsx` | `tests/tools.test.ts` |
| 属性面板（时间/值/段模式输入，规格 5.3） | 已实现 | `pages/Editor.tsx#NodePanel` | 逻辑经提交路径复用几何核心；UI 交互未在真实窗口自动化验证 |
| **指针手势的真实窗口行为（拖拽/自由画手感）** | **未验证** | `CurveLayer.tsx` | 依赖 `getBoundingClientRect` 与真实指针，未做 GUI 自动化 |
| 编辑内容 → 保存 → 重开一致 | 已实现/已实测 | `App.EditorHost` + `project-service.saveProject` | `tests/project-service.test.ts`（新增节点保存重开一致） |

> 说明：阶段 B 的**几何核心、渲染、历史、工具状态机**均已实现并有自动化证据；
> 曲线已叠加到画布。**指针手势在真实窗口的手感（自由画/拖拽/框选）尚未做自动化验证**，
> 需 GUI 手动或 Playwright 补测。标注（M）与分段（S）属阶段 C，界面禁用并注明。

## 4. 阶段 C 明细（标注 / 分段 / 项目库）

| 需求 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 标注数据操作（新增唯一性、修改、删除、标题上限、时间唯一） | 已实现/已实测 | `shared/annotations.ts` | `tests/annotations.test.ts` |
| 标注渲染（黄点、标题标签、连接线、偏移夹紧） | 已实现/已实测（渲染） | `components/CurveLayer.tsx` | `tests/curve-layer.test.tsx` |
| 标注交互（点击选中并定位、拖点改时间、拖标签改偏移、M 工具添加、播放头标注） | 已实现；**真实窗口手势未验证** | `CurveLayer.tsx`, `pages/Editor.tsx` | 逻辑经提交路径复用纯函数 |
| 标注编辑面板（时间/标题/正文、正文→标题回退、删除、定位） | 已实现 | `pages/Editor.tsx#AnnotationPanel` | 规格 6.1 的“小卡片”以右侧属性面板承载（MVP 决策） |
| 标注列表 + 标题/正文搜索 | 已实现 | `pages/Editor.tsx#ListPanel` | 规格 6.2 |
| 分段数据操作（新增分割、拖动夹紧、锁定、删除合并备注） | 已实现/已实测 | `shared/sections.ts` | `tests/sections.test.ts` |
| 分段渲染（画布竖向虚线、顶部拖柄、锁定标记、段名；时间线段落条） | 已实现/已实测（渲染） | `CurveLayer.tsx`, `components/Timeline.tsx` | `tests/curve-layer.test.tsx` |
| 分段交互（S 工具添加、拖边界、锁定、删除合并确认提示） | 已实现；**真实窗口手势未验证** | `CurveLayer.tsx`, `Editor.tsx` | 单次操作后回选择工具 |
| 段落列表（起止时间、名称、备注编辑、锁定、删除） | 已实现 | `pages/Editor.tsx#SectionPanel/ListPanel` | 规格 7 |
| 标注归属段落（边界归右侧、duration 归最后一段） | 已实现/已实测 | `shared/sections.ts#resolveSectionForTime` | `tests/sections.test.ts`、`tests/analysis-doc.test.ts` |
| 编辑 → 保存 → 重开（内容一致，schema 通过） | 已实现/已实测 | `App.EditorHost` + `project-service` | `tests/analysis-doc.test.ts`、`tests/project-service.test.ts` |
| 项目库搜索 / 重命名 / 从最近移除 + 撤销提示 | 已实现 | `pages/Home.tsx` | 纯函数 `filterProjects` 未单测 |
| 自动保存（内容+视图防抖 1s）、保存状态顶栏 | 已实现 | `App.EditorHost` | 规格 8.2 |
| 撤销/重做覆盖标注与分段 | 已实现（快照式历史天然覆盖） | `shared/history.ts` + `App.EditorHost` | 未做标注/分段专用历史用例 |
| 恢复快照（异常退出，F02）、素材缺失重新定位（G01） | **未实现** | — | 见第 8 节 |

## 5. 阶段 D 明细（输出已交付部分）

| 需求 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| Markdown 分析笔记生成（项目/时长/段落/标注/归属/转义） | 已实现/已实测 | `shared/export-markdown.ts` | `tests/export-markdown.test.ts` |
| PNG 导出模型（固定 2400×1000、坐标、刻度、边界、标注编号、底部索引、前 100 截断） | 已实现/已实测 | `shared/export-png.ts` | `tests/export-png.test.ts` |
| 导出保存（原生保存对话框 + 原子写入 + 取消/覆盖/失败语义） | 已实现/已实测 | `main/services/export-service.ts`, `ipc.ts`, `main.ts` | `tests/export-service.test.ts` |
| 导出入口（顶栏导出菜单：PNG 完整/当前范围、Markdown；导出前等待保存完成） | 已实现 | `pages/Editor.tsx`, `renderer/export/render-png.ts` | 逻辑已接线；**PNG Canvas 光栅化未在窗口内验证** |
| 兼容副本（WebM/VP8/Opus，长边≤1280、30fps CFR、yuv420p、无音频 -an、时长差异 ≤100ms 校验） | 已实现/已实测 | `main/services/compatible-copy-service.ts`, `project-service.setPlaybackSource`, `ipc.ts` | `tests/compatible-copy.test.ts`（真实 ffmpeg 转 vp8/opus） |
| 缩略图与封面生成（160×90、≤120 张、SHA+参数+版本缓存键、单帧失败非致命） | 已实现/已实测 | `main/services/thumbnail-service.ts`, `ipc.ts` | `tests/thumbnails.test.ts`（真实 ffmpeg） |
| 素材重新探测（media.probe 真实实现） | 已实现 | `ipc.ts`, `services/ffmpeg.ts` | 复用真实 ffprobe |
| 恢复快照（F02：保存前写 pending、成功后清理、打开检测、恢复时保留原版本） | 已实现/已实测 | `project-service.ts`, `pages/Editor.tsx` | `tests/recovery-relocate.test.ts` |
| 素材缺失重新定位（G01：SHA-256 一致才接受；不一致拒绝） | 已实现/已实测 | `project-service.relocateSource`, `ipc.ts`, `pages/Home.tsx` | `tests/recovery-relocate.test.ts` |
| 缩略图/重定位入口（项目库卡片按钮），封面经 laipian-media: 展示 | 已实现 | `pages/Home.tsx`, `App.tsx` | 卡片按钮 + 提示 |
| 备份列表 / 恢复到指定备份 | 已实现（服务层 + 测试），UI 未接线 | `project-service.ts` | — |
| 兼容副本的**导入期内自动触发与策略页**（导入时判定 needs-compatible-copy → 提示生成） | **未实现** | — | 通道已真实可用，导入流程未接线（无假按钮） |
| 后台任务取消 | 已实现（`services/tasks.ts#startTask/cancel`，测试覆盖） | — | 取消转码/缩略图有效 |
| macOS arm64 打包（I02） | 已实现/已实测 | `forge.config.ts`, `assets/icon.icns` | `.app` / ZIP / DMG；本机临时签名；成品冒烟通过 |
| 性能测量（I01） | **未验证** | — | 见第 8 节 |

- 打包：darwin-arm64 `.app`、ZIP、DMG 已构建并实测；Windows 安装器与 macOS Intel 包未构建。

## 6. 验收清单（规格 18）状态

| 编号 | 状态 | 说明 |
|---|---|---|
| A01 首次离线启动 | 已实测 | 冒烟无登录直接进入项目库 |
| A02 中文/空格/emoji 路径导入 | **未验证** | 服务层路径处理为字符串透传 + `path` API，未在真实中文路径素材上跑安装包 |
| A03 拖入两个视频 | **未实现** | 拖入入口未实现（仅系统选择器） |
| A04 同名项目两次 | 已实测 | `uniqueFolder` 附加短 UUID；测试覆盖目录名过滤 |
| A05 从最近移除 | 已实测 | 测试：索引移除、磁盘保留 |
| A06 复制文件夹到另一系统 | **未验证** | 相对路径已保证（无绝对路径入库），未跨机器实测 |
| B01—B05 | 逻辑已实测 / 真实窗口未验证 | 坐标映射与节点/标注归属由 `tests/editor-skeleton.test.ts`、`tests/geometry.test.ts`、`tests/curve-layer.test.tsx` 覆盖；B03/B04 播放与图层由冒烟与既有实现覆盖；**真实窗口拖拽手感未做自动化** |
| C01—C06 | 逻辑已实测 / 真实窗口未验证 | 曲线几何（自由画区间外不变、贝塞尔约束、夹紧）由 `tests/geometry.test.ts` 覆盖；**真实窗口手势未自动化** |
| D01—D04 | 逻辑已实现/已实测，真实窗口未验证 | 标注增改删/唯一性/归属/标签偏移由 `tests/annotations.test.ts`、`tests/analysis-doc.test.ts` 覆盖；重叠与搜索由列表实现；真实窗口交互未自动化 |
| E01—E03 | 逻辑已实现/已实测，真实窗口未验证 | 分段增删拖动/锁定/合并/归属由 `tests/sections.test.ts`、`tests/analysis-doc.test.ts` 覆盖；真实窗口手势未自动化 |
| F01 连续编辑保存重开 | 部分已实测 | revision 锁与原子写已测；UI 端到端未测 |
| F02 保存中强杀 | 服务层已实测 / 真实窗口未验证 | `tests/recovery-relocate.test.ts`：写 pending→检测→恢复并保留原版本；真实强杀窗口未演练 |
| G01 视频缺失 | 已实现/已实测 | 状态推导 `missing`；`relocateSource` 仅接受 SHA-256 一致文件，不一致拒绝（`tests/recovery-relocate.test.ts`） |
| G02 不兼容编码 | 已实现/已实测 | 真实 ffmpeg 生成 WebM/VP8/Opus 并校验时长（`tests/compatible-copy.test.ts`）；**导入期自动触发策略页未实现** |
| G03 转换取消 | 部分 | 任务取消框架已实测（tasks cancel）；取消转码的真实中断未单独演练 |
| G04 无音轨/竖屏/VFR | 部分已实现 | `audioCodec:null` 不造假音轨（兼容副本 -an 已测）；HDR/VFR 检测有；未用真实样本实测 |
| G05 长片 Range | 部分 | 协议 206/416 已测；真实长片未测 |
| H01—H03 导出 | 部分已实测 | Markdown 全链路与 PNG 模型/保存服务已实测（`tests/export-markdown.test.ts`、`tests/export-png.test.ts`、`tests/export-service.test.ts`）；**PNG Canvas 光栅化未在窗口内验证** |
| I01 性能压力 | **未验证** | 未做真实素材性能测量 |
| I02 无 Node/FFmpeg 环境安装 | macOS arm64 已实测 | FFmpeg / ffprobe 随 `.app` 分发，打包后冒烟通过；其他平台未验证 |
| I03 卸载重装保留项目 | **未验证** | 卸载策略未实测 |

## 7. 自动化测试覆盖（可复现）

`npm test`（259 例 / 23 文件）覆盖规格 18 “自动化至少覆盖”中的：
- 坐标往返误差、不同尺寸与缩放、缩放锚点/平移：`tests/editor-skeleton.test.ts`
- 自由画替换区间外不变、节点夹紧、多节点位移、贝塞尔按时间求值：`tests/geometry.test.ts`（24 例）
- 撤销重做（含合并与上限）：`tests/history.test.ts`（9 例）
- 工具快捷键与命中优先级：`tests/tools.test.ts`（8 例）
- 曲线/标注/分段渲染坐标映射：`tests/curve-layer.test.tsx`
- 分段新增/拖动夹紧/锁定/合并/归属：`tests/sections.test.ts`
- 标注唯一性/修改/删除/标题退避：`tests/annotations.test.ts`
- 分段+标注串联后仍满足 schema 与归属：`tests/analysis-doc.test.ts`
- 编辑曲线→保存→重开一致：`tests/project-service.test.ts`
- Markdown 导出（内容/归属/转义）：`tests/export-markdown.test.ts`
- PNG 导出模型（尺寸/坐标/编号/索引截断）：`tests/export-png.test.ts`
- 导出保存（取消/覆盖/失败、原子写入）：`tests/export-service.test.ts`
- schema 拒绝坏数据、路径穿越：`tests/schema.test.ts`
- 保存 revision 竞争、原子写入失败恢复：`tests/project-service.test.ts`
- 复制/哈希、取消清理、磁盘空间估算、媒体策略：`tests/media.test.ts`
- 协议 Range/206/416、注册表授权、URL 解析：`tests/protocol.test.ts`
- 任务取消与事件补齐、startTask 立即返回 taskId：`tests/tasks.test.ts`
- 恢复快照（pending 检测 / 恢复 / 丢弃）与素材重定位（SHA 一致/不一致）：`tests/recovery-relocate.test.ts`
- 缩略图/封面（采样计划、失败非致命、真实 ffmpeg 抽帧与缓存命中）：`tests/thumbnails.test.ts`
- 兼容副本（参数、失败清理、时长容差、真实 ffmpeg 转 vp8/opus）：`tests/compatible-copy.test.ts`
- 项目库搜索 `filterProjects`（排序/搜索/隐藏）：`tests/home-filter.test.ts`
- **真实媒体贯通**（真实 ffprobe）：`tests/project-service-real-media.test.ts`
- 真实窗口指针手势（自由画/拖拽/框选/标注/分段）：**未自动化**（需 GUI 或 Playwright）
- 导入期拖入 / 导入策略页自动触发兼容副本：**未实现**

## 8. 已知边界与阻塞项

1. **公开发行签名尚缺外部条件**：macOS arm64 包已完成本机临时签名并通过完整性校验，但没有 Apple Developer ID 证书与公证；不能把它当作面向公众下载的免提示发行包。
2. **FFmpeg 许可材料需在公开发布前补齐**：macOS arm64 已随包分发 FFmpeg 6.0 与 ffprobe 4.4.1；公开发行前仍需确认对应构建许可、附带声明及源代码提供义务。
3. **未构建/未验证的平台**：Windows x64 安装器、macOS x64（Intel）——当前机器无环境，**不得记为已验证**。
4. **真实窗口指针手势未验证（阶段 B/C）**：曲线/节点/控制柄、标注点/标签、分段虚线的渲染与数据操作均有自动化证据；但自由画/拖拽/框选、拖标注、拖分段等 Pointer 手势依赖真实布局与指针，未做 GUI 自动化（需手动或 Playwright 补测）。
5. **导入期兼容策略页未接线**：兼容副本、缩略图、导出服务已真实实现；导入时自动提示生成兼容副本仍待完成。
6. **拖入导入未实现**：仅支持系统文件选择器（规格 2.3 拖入路径待补）。
7. **性能目标（规格 16.1）未测量**：打开耗时、拖动反馈、内存、长片等均为待测目标，未做真实测量，不得声称达标。
8. **PNG Canvas 光栅化未在窗口内验证**：PNG 的坐标/内容/索引模型与保存服务均有自动化证据，但 renderer 的 Canvas 绘制与中文文本渲染需在真实窗口内目视或截图核对；Markdown 导出已全链路验证。

## 9. 如何复现本轮验证

```bash
npm install                 # 依赖已精确锁定
npm run typecheck           # 四套 tsconfig 均需通过
npm test                    # 286 passed；含真实 ffprobe/ffmpeg、保存并发、曲线/标注/分段、导出、恢复与重定位、帧带与精确帧
npm run smoke               # 需 GUI 会话；输出 SMOKE_OK + 媒体协议 + 帧带/精确帧探针
npm run build               # 含 electron-forge package（darwin arm64）
```

真实媒体验证素材：`dev-assets/dev-test.mp4`（10s H.264/AAC，320×180，30fps）。

## 10. 阶段 E（v1.1 继续优化）P0：时间线帧带 + 节点帧联动

> 需求：《拉片台继续优化需求文档 v1.1》。本轮只做 P0（功能一 + 功能二）。
> 功能三（快捷键）留待下一轮，且按用户要求做成**用户可自定义、有修改入口**。

| 需求 | 状态 | 实现位置 | 验证 |
|---|---|---|---|
| 时间线视频帧带（连续画面、16:9 容器、深色填充、点击定位） | 已实现 + 已实测 | `renderer/components/Timeline.tsx`、`renderer/editor/filmstrip.ts` | `tests/filmstrip.test.ts`；冒烟 thumb probe |
| 帧带缩放自适应、同屏 ≤24 张真实 DOM、懒加载 | 已实现 + 已实测 | `filmstrip.buildFilmstrip` | `tests/filmstrip.test.ts` |
| 缩略图列表接口（时间点 + 受控 URL，复用已有 120 张基础帧） | 已实现 + 已实测 | `main/ipc.ts media:list-thumbnails`、`thumbnail-service.listThumbnailEntries` | `tests/thumbnails.test.ts`；冒烟 thumb probe（160×90×10） |
| 协议命名资源（thumb/frame 受控文件名，防目录遍历） | 已实现 + 已实测 | `shared/media-url.ts`、`main/protocol.ts` | `tests/protocol.test.ts`（夹带/非法名 → 403） |
| 点击曲线节点：暂停 + 定位播放器 + 选中 + 视口平移（不改缩放） | 已实现（逻辑） | `pages/Editor.tsx`（`onSelectNodes` / `ensureTimeVisible`） | 复用既有 seek/几何路径；真实窗口指针手感未自动验证 |
| 节点浮层预览卡（上方优先、边缘内偏移、不遮节点） | 已实现 | `components/CurveLayer.tsx`（`previewFrame`） | 未自动化，待真实窗口目视确认 |
| 右侧节点面板「对应画面」区（时间码/帧号/值，点击再定位） | 已实现 | `pages/Editor.tsx` `NodePanel` | — |
| 精确帧接口 + 缓存 + LRU + 帧号/VFR 规则 | 已实现 + 已实测 | `main/services/frame-service.ts`、`media:get-frame-preview` | `tests/frame-service.test.ts`（含真实 ffmpeg 抽帧） |
| 请求竞态（旧结果不覆盖最新）与拖动节流 | 已实现 + 已实测 | `renderer/editor/frame-request.ts`、`hooks/useFramePreview.ts` | `tests/frame-request.test.ts` |
| 打包后真实视频冒烟 | 部分验证 | `main/main.ts`（smoke 新增 frame/thumb 探针） | 开发构建 `SMOKE_OK`；**打包应用冒烟受本机环境阻塞（见下）** |

测试总数：**286 passed / 26 files**（新增 `filmstrip` 8、`frame-service` 10、`frame-request` 3，及 `protocol`/`thumbnails` 若干用例）。
`npm run typecheck` 四套 tsconfig 全过；`npm run package` 成功产出 `out/拉片台-darwin-arm64`。

已知限制（阶段 E）：
- 打包应用无法透传 `--smoke`（Chromium 拒绝未知开关），已改为“环境变量 + 触发文件”触发冒烟，并让结果同时落盘；
- 本机存在运行中的 `/Applications/拉片台.app`，同 bundle id 导致打包应用被 macOS 复用/单实例锁拦截，**未在无干扰环境复测打包应用冒烟**（不擅自终止用户正在使用的应用）；
- 帧带放大时暂用“最近基础帧”重复填充（需求 4.3 允许的第一版行为）；按需局部高精度生成属第二阶段；
- 节点浮层预览卡与拖动中画面跟随未做 GUI 自动化，需真实窗口目视确认。
## 11. 阶段 F（v1.1）P1：快捷键 + 速查面板 + 用户自定义

> 需求：v1.1 6.x。用户明确要求**快捷键可自定义、有修改入口**（超出文档 6.3 的“第一版只展示”）。

| 需求 | 状态 | 实现位置 | 验证 |
|---|---|---|---|
| 键位调整：L 归还播放、直线改 D、M 播放头加标注、标注编辑改 N | 已实现 + 已实测 | `renderer/editor/tools.ts`、`shared/keymap.ts` | `tests/tools.test.ts`、`tests/keymap.test.ts` |
| 播放/逐帧/导航：Space、←/→ 按 fps、Shift 5 帧、J/K/L、Home/End、↑/↓ | 已实现 | `renderer/pages/Editor.tsx`、`hooks/useMediaPlayer.ts`（倍速） | `commandForEvent` 单测；真实按键手感需窗口确认 |
| 分析操作：M 加标注、Shift+M 下一条、V/P/B/D/N/S、Delete/Backspace、Esc | 已实现 | `Editor.tsx` | 同上 |
| 时间线：=/+、-、\、Cmd/Ctrl+Z、Shift+Z、Cmd/Ctrl+S、? | 已实现 | `Editor.tsx`（zoomBy/fitAll） | 同上 |
| 输入框聚焦不触发全局快捷键 | 已实现 | `Editor.tsx` keydown 守卫 | 既有行为保留 |
| 速查面板（分类、按平台显示 Command/Ctrl、Esc 关闭） | 已实现 | `components/ShortcutHelpDialog.tsx` | 真实窗口目视待确认 |
| 用户自定义：录制改键 + 冲突检测 + 单项/全部恢复默认 | 已实现 + 已实测 | `hooks/useKeymap.ts`、`main/services/settings-service.ts` | `settings-service` 读写/校验单测；冒烟 settings 往返探针 |
| 全局持久化（userData/settings.json，跨项目） | 已实现 + 已实测 | `main/services/settings-service.ts`、`settings:*` IPC | `tests/settings-service.test.ts`；冒烟 `settings probe` |
| 工具栏键位同步自定义结果 | 已实现 | `Editor.tsx`（TOOL_COMMAND + formatBinding） | 目视待确认 |

测试总数：**306 passed / 28 files**（新增 `keymap`、`settings-service`，更新 `tools`）。
`npm run smoke`：`SMOKE_OK`，新增 `settings probe`（get/set/get 往返与持久化）通过。

已知限制（阶段 F）：
- 真实按键手感（逐帧、J/K/L、面板录制）未做 GUI 自动化，需真实窗口确认；
- J 为“反向逐帧步进”（按住由系统 key repeat 连续），非真正的负速率反向播放——速查面板文案已如实标注；
- 打包需设 `ELECTRON_ZIP_DIR` 指向本机 Electron zip 缓存（无网络环境），否则 forge 会尝试联网下载失败。
## 12. 阶段 G（v1.1 后续）智能识别镜头（硬切检测）

> 需求：自动识别明显硬切并在时间线生成镜头分割线；只做硬切、不用大模型、不真正切视频。

| 需求 | 状态 | 实现位置 | 验证 |
|---|---|---|---|
| 时间线附近“智能识别镜头”按钮 + 三档灵敏度（14/10/8）+ 最短镜头（默认 0.5s） | 已实现 | `renderer/pages/Editor.tsx`、`shared/shots.ts` | 真实窗口目视待确认 |
| 后台分析、进度、可取消 | 已实现 + 已实测 | `main/services/shot-detect-service.ts`、tasks（kind `shot-detect`） | 单测取消；冒烟 `shot probe` |
| FFmpeg scdet 检测（内置 FFmpeg，无 Python/OpenCV/模型） | 已实现 + 已实测 | `shot-detect-service.shotDetectArgs` | 真实 ffmpeg 集成测试 + 冒烟 |
| 日志解析 `lavfi.scd.score/time` → 整数毫秒、排序、去头尾、最短镜头过滤 | 已实现 + 已实测 | `parseScdetLine` / `filterDetectedCuts` | `tests/shot-detect-service.test.ts` |
| 候选分割线与正式分段不同样式、可点击删除 | 已实现 | `renderer/components/Timeline.tsx`、`shot-apply.ts` | 真实窗口目视待确认 |
| “应用结果”才转正式分段；不覆盖手动/锁定边界；100ms 去重；一次撤销 | 已实现 + 已实测 | `renderer/editor/shot-apply.ts`（复用 `addBoundary`） | `tests/shot-apply.test.ts` |
| 命名「镜头 001/002/003」 | 已实现 + 已实测 | `shot-apply.ts` | `tests/shot-apply.test.ts` |
| 缓存按 SHA + 阈值 + 最短镜头长度；相同参数命中 | 已实现 + 已实测 | `shot-detect-service.ts`（`cache/shots/`） | `tests/shot-detect-service.test.ts` |
| 失败不改 `project.json`；候选不入正式数据；renderer 无真实路径 | 已实现 | 服务只写 cache；候选为 renderer 临时状态 | 单测（失败不写缓存） |
| macOS 打包后仍能用内置 FFmpeg 检测 | 已实测（开发构建冒烟） | `main/main.ts` smoke `shot probe` | `shot probe: {ok:true, cuts:1, firstMs:2000}` |

FFmpeg 参数（固定）：
```
-hide_banner -nostats -i <源> -map 0:v:0 -vf "scale=480:-2,scdet=t=<阈值>" -an -sn -dn -f null -
```
（`runFfmpeg` 自动前置 `-progress pipe:1` 驱动进度与无进度看门狗。）

测试总数：**324 passed / 30 files**（新增 `shot-detect-service`、`shot-apply`）。

已知易误判：
- 快速横摇/推拉/大面积运动、闪光灯或亮度突变、纯色/黑场切换、字幕整屏切换容易被判为切点（灵敏档更明显）；
- 同机位跳剪、极短镜头（< 最短镜头长度）会被去重合并；
- 淡入淡出/叠化**不**识别（本功能只做硬切）；
- 阈值越高越保守（保守 14 误判更少但可能漏检），建议先用“标准”再用“灵敏”补漏。
## 13. 右侧列表固定显示（UI 调整，0.4.1）

- 右栏改为**常驻固定显示**（宽 280px，不再随选择/列表开关收起）；
- 布局：**属性区在上**（有选中节点/标注/分段时显示，最高 55% 并自行滚动），**列表固定显示在下**（占余下高度、自行滚动）；未选中时属性区显示“未选择对象”提示；
- 移除顶栏“列表”开关按钮与列表内的关闭按钮；选中对象不再隐藏列表（原先二者互斥）；
- 验证：`npm run typecheck` + **324 测试**通过；`npm run smoke` `SMOKE_OK`；真实窗口布局与滚动需目视确认。
## 14. 快捷键支持滚轮手势 + 显式 Ctrl 修饰（修复，0.4.2）

**问题**：把「缩放时间线」改成 Ctrl+鼠标滚轮时改不上——录制只监听 `keydown`，滚轮/中键滚动不产生 `keydown`，面板一直停在“按下新键…”；且修饰符只有 `mod/shift/alt`，macOS 上无法表达 Control（与 Command 不同）。

**修复**：
- `shared/keymap.ts`：新增键名 token `wheel`；新增**显式 `ctrl` 修饰符**（macOS 上是 Control ⌃，与 Command ⌘ 区分；Windows/Linux 上 Ctrl 已计入 mod，不重复）；新增 `wheelToBinding` / `commandForWheel`；新增两条命令 `timeline.wheelZoom`（默认 `alt+wheel`）与 `timeline.wheelPan`（默认 `shift+wheel`，与原 Shift+滚轮平移一致），均可自定义。
- `ShortcutHelpDialog`：录制态额外捕获 `wheel`（capture + 非 passive，阻止页面缩放），滚轮/中键滚动现在能正常录成如 `⌃滚轮`。
- `Timeline`：Shift+滚轮平移改为读取自定义键位（`resolveWheelIntent`）；缩放**以鼠标位置为锚点**。
- `Editor`：按当前键位解析滚轮意图；并全局阻止 Ctrl/Command+滚轮触发浏览器页面缩放。

**验证**：`npm run typecheck` + **329 测试**通过（新增滚轮键位单测）；`npm run smoke` `SMOKE_OK`；打包 0.4.2。
**注意**：macOS 上“Ctrl+滚轮”指按住 **Control（⌃）** 键滚动；想用 Command 请绑 ⌘。中键滚动与普通滚轮产生同样的 wheel 事件，故统一处理。
