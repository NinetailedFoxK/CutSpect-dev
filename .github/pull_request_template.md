## 改动说明

<!-- 一句话说明这次 PR 做了什么、为什么。 -->

## 平台影响

- [ ] 仅共享代码（renderer/shared/main），两端一致
- [ ] 涉及平台适配层 `src/platform/`（请说明 macOS / Windows 各自行为）
- [ ] 涉及打包配置 `forge.config.ts` / 图标 / 签名

## 自查清单

- [ ] 未新增 `EditorMac.tsx` / `EditorWindows.tsx` 之类的平台分叉页面
- [ ] 未把绝对路径写入项目数据（项目内媒体使用 `media/…` 相对路径）
- [ ] 用户可见文案中的系统术语（文件管理器名称、主修饰键）取自平台适配层
- [ ] 已运行 `npm run verify` 且通过
- [ ] 涉及 FFmpeg/ffprobe、文件路径、快捷键、导出的改动：注明是否在真实
      Windows 与 macOS 验证

## 验证方式

<!-- 描述测试与验证过程。若某项只能在 Windows 完成而本机不是 Windows，请注明交由 CI 或真机验证。 -->