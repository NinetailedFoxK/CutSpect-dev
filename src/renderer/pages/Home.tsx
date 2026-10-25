import { useEffect, useMemo, useState } from 'react';
import type { OpenedProject, ProjectCardStatus, ProjectSummary } from '@shared/api-types';
import { formatTimeMs } from '@shared/time';
import { formatRelativeTime } from '../lib/format';
import { NewProjectDialog } from '../components/NewProjectDialog';
import { BrandMark } from '../components/BrandMark';
import type { NewProjectCreatedInfo } from '../components/NewProjectDialog';
import { RenameProjectDialog } from '../components/RenameProjectDialog';
import type { RecentProjectsController } from '../hooks/useRecentProjects';
import { feedbackStore } from '../feedback/instance';
import { Icon } from '../components/Icons';

/**
 * 项目库 HOME（规格 2.1 / 2.2）。
 *
 * 分层：
 * - 数据来自注入的 RecentProjectsController（App 用 useRecentProjects 组合，
 *   dev demo 注入固定样例），本组件不直接访问 window.laipian.projects.listRecent；
 * - “打开项目文件夹”是本页内完成的完整真实链路：
 *   pickOpenProjectFolder() → projects.open() → 成功后回调 onProjectOpened；
 * - 卡片“打开”入口由父级通过 canOpenProject 控制可用性：
 *   阶段 A main 侧没有按 projectId 直接打开项目的通道（契约仅有基于选择令牌的
 *   projects.open），因此入口禁用并给出真实原因，集成阶段接线后启用；
 * - “从最近列表移除”只移除应用内索引（规格 2.2）：调 removeRecent 成功后
 *   本地隐藏 + 5 秒可撤销 toast。撤销恢复本地展示；索引的持久恢复依赖 main
 *   侧撤销通道（当前契约未含，集成阶段确认），列表刷新后以 main 数据为准。
 */

export type HomeProjectOpenedInfo = OpenedProject;

export interface HomeProps {
  hasApi: boolean;
  recent: RecentProjectsController;
  /** 从最近卡片直接打开的可用性（有 Electron API 即为 true）。 */
  canOpenProject: boolean;
  openProjectDisabledReason: string;
  /** 新建项目创建成功 → App 切换到导入页。 */
  onProjectCreated: (info: NewProjectCreatedInfo) => void;
  /** “打开项目文件夹”链路成功（projects.open 返回完整结果）→ App 进入工作台。 */
  onProjectOpened: (opened: OpenedProject) => void;
  /** 打开最近项目卡片 → App 按 projectId 打开。 */
  onOpenProject: (project: ProjectSummary) => void;
  /** 素材缺失时重新定位（规格 9.3）；缺省则不显示该操作。 */
  onRelocateSource?: (project: ProjectSummary) => void;
  /** 重新生成缩略图与封面（规格 10.3）；缺省则不显示该操作。 */
  onRebuildThumbnails?: (project: ProjectSummary) => void;
  /**
   * 导入失败"重新导入"用：App 每次递增该计数，Home 监听到变化即打开新建弹窗。
   * 0 或缺省时不触发。
   */
  openCreateRequest?: number;
}

/** 状态徽标中文文案（规格 2.2 / 2.4 状态推导）。 */
const STATUS_LABEL: Record<ProjectCardStatus, string> = {
  ready: '可编辑',
  'pending-compatible': '待兼容处理',
  missing: '项目位置已改变',
};

const STATUS_BADGE_CLASS: Record<ProjectCardStatus, string> = {
  ready: 'home-badge home-badge--ready',
  'pending-compatible': 'home-badge home-badge--pending',
  missing: 'home-badge home-badge--missing',
};

/**
 * 搜索过滤 + 最近编辑降序排序（规格 2.2）。
 * 导出为纯函数供 DOM 断言脚本与后续单测复用。
 */
export function filterProjects(
  projects: readonly ProjectSummary[],
  query: string,
  hiddenIds: ReadonlySet<string>,
): ProjectSummary[] {
  const keyword = query.trim().toLowerCase();
  return projects
    .filter((p) => !hiddenIds.has(p.projectId))
    .filter(
      (p) =>
        keyword.length === 0 ||
        p.name.toLowerCase().includes(keyword) ||
        p.sourceOriginalName.toLowerCase().includes(keyword),
    )
    // 默认按最近编辑降序（规格 2.2）；ISO 8601 字符串按字典序即时间序。
    .sort((a, b) => (a.lastEditedAt < b.lastEditedAt ? 1 : -1));
}

/* ------------------------------------------------------------------ */
/* 项目卡片                                                             */
/* ------------------------------------------------------------------ */

interface ProjectCardProps {
  project: ProjectSummary;
  hasApi: boolean;
  canOpen: boolean;
  openDisabledReason: string;
  onOpen: (project: ProjectSummary) => void;
  onRename: (project: ProjectSummary) => void;
  onReveal: (project: ProjectSummary) => void;
  onRemove: (project: ProjectSummary) => void;
  onRelocate?: (project: ProjectSummary) => void;
  onRebuildThumbnails?: (project: ProjectSummary) => void;
}

/** 封面深色占位图块（coverMediaUrl 为 null 或加载失败时使用，不用假图）。 */
function CoverPlaceholder() {
  return (
    <div className="home-card-cover home-card-cover--placeholder" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="34" height="34">
        <path
          d="M18 13.5 34 24 18 34.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <rect
          x="4"
          y="8"
          width="40"
          height="32"
          rx="4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 4"
        />
      </svg>
    </div>
  );
}

function ProjectCard({
  project,
  hasApi,
  canOpen,
  openDisabledReason,
  onOpen,
  onRename,
  onReveal,
  onRemove,
  onRelocate,
  onRebuildThumbnails,
}: ProjectCardProps) {
  const [coverFailed, setCoverFailed] = useState(false);
  const canOpenThis = canOpen && project.status !== 'missing';
  const openTitle = !canOpen
    ? openDisabledReason
    : project.status === 'missing'
      ? '项目位置已改变：请用“打开项目文件夹”重新定位'
      : '双击或点击“打开”进入分析工作台';

  return (
    <article className={`home-card home-card--${project.status}`}>
      <div
        className="home-card-main"
        title={openTitle}
        onDoubleClick={canOpenThis ? () => onOpen(project) : undefined}
      >
        {project.coverMediaUrl !== null && !coverFailed ? (
          <div className="home-card-cover">
            <img
              src={project.coverMediaUrl}
              alt=""
              loading="lazy"
              onError={() => {
                setCoverFailed(true);
              }}
            />
          </div>
        ) : (
          <CoverPlaceholder />
        )}
        <div className="home-card-info">
          <span className={STATUS_BADGE_CLASS[project.status]}>{STATUS_LABEL[project.status]}</span>
          <h3 className="home-card-name" title={project.name}>
            {project.name}
          </h3>
          <p className="home-card-source" title={project.sourceOriginalName}>
            {project.sourceOriginalName}
          </p>
          <p className="home-card-meta">
            <span>{project.durationMs !== null ? formatTimeMs(project.durationMs) : '—'}</span>
            <span aria-hidden="true">·</span>
            <span>最近编辑 {formatRelativeTime(project.lastEditedAt)}</span>
          </p>
        </div>
      </div>
      <div className="home-card-actions">
        <button
          type="button"
          className="home-card-button home-card-button--primary"
          disabled={!canOpenThis}
          title={openTitle}
          onClick={() => onOpen(project)}
        >
          <Icon name="arrow-right" />
          <span>打开</span>
        </button>
        <details className="home-card-menu">
          <summary aria-label={`更多项目操作：${project.name}`} title="更多操作"><Icon name="more-horizontal" /></summary>
          <div className="home-card-menu-popover">
            <button
              type="button"
              className="home-card-button"
              disabled={!hasApi}
              onClick={() => onRename(project)}
            >
              <Icon name="edit" />
              <span>重命名</span>
            </button>
            <button
              type="button"
              className="home-card-button"
              disabled={!hasApi}
              onClick={() => onReveal(project)}
            >
              <Icon name="reveal-finder" />
              <span>在文件管理器中显示</span>
            </button>
            {project.status === 'missing' && onRelocate && (
              <button
                type="button"
                className="home-card-button"
                disabled={!hasApi}
                onClick={() => onRelocate(project)}
              >
                <Icon name="open-folder" />
                <span>重新定位素材</span>
              </button>
            )}
            {project.status !== 'missing' && onRebuildThumbnails && (
              <button
                type="button"
                className="home-card-button"
                disabled={!hasApi}
                onClick={() => onRebuildThumbnails(project)}
              >
                <Icon name="retry" />
                <span>重新生成缩略图</span>
              </button>
            )}
            <button
              type="button"
              className="home-card-button home-card-button--danger"
              disabled={!hasApi}
              onClick={() => onRemove(project)}
            >
              <Icon name="trash" />
              <span>从最近列表移除</span>
            </button>
          </div>
        </details>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

export function Home({
  hasApi,
  recent,
  canOpenProject,
  openProjectDisabledReason,
  openCreateRequest,
  onProjectCreated,
  onProjectOpened,
  onOpenProject,
  onRelocateSource,
  onRebuildThumbnails,
}: HomeProps) {
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [openingFolder, setOpeningFolder] = useState(false);

  // 导入失败"重新导入"：App 递增计数 → 打开新建弹窗（规格 2 失败处理）。
  useEffect(() => {
    if (openCreateRequest === undefined || openCreateRequest === 0) {
      return;
    }
    setCreateOpen(true);
  }, [openCreateRequest]);

  const projects = recent.state.phase === 'ready' ? recent.state.projects : [];
  const visibleProjects = useMemo(
    () => filterProjects(projects, query, new Set(hiddenIds)),
    [projects, query, hiddenIds],
  );


  /** 打开项目文件夹：完整真实链路 pickOpenProjectFolder → projects.open。 */
  const openProjectFolder = async (): Promise<void> => {
    const api = window.laipian;
    if (!api || openingFolder) {
      return;
    }
    setOpeningFolder(true);
    try {
      const picked = await api.dialog.pickOpenProjectFolder();
      if (!picked.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '打开选择器失败',
          message: picked.error.message,
          actions: [{ label: '关闭', run: () => feedbackStore.clearBanner() }],
        });
        return;
      }
      if (picked.data === null) {
        return; // 用户在系统选择器中取消，静默返回。
      }
      const opened = await api.projects.open({ projectSelectionToken: picked.data });
      if (!opened.ok) {
        feedbackStore.showBanner({
          kind: 'error',
          title: '打开项目失败',
          message: opened.error.message,
          actions: [
            { label: '重试', primary: true, run: () => void openProjectFolder() },
            { label: '关闭', run: () => feedbackStore.clearBanner() },
          ],
        });
        return;
      }
      onProjectOpened(opened.data);
    } finally {
      setOpeningFolder(false);
    }
  };

  const revealProject = async (project: ProjectSummary): Promise<void> => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    const result = await api.projects.reveal({ projectId: project.projectId });
    if (!result.ok) {
      feedbackStore.pushToast({
        kind: 'error',
        message: `无法在文件管理器中显示「${project.name}」：${result.error.message}`,
      });
      return;
    }
    feedbackStore.pushToast({ kind: 'info', message: '已在系统文件管理器中显示项目文件夹。' });
  };

  const removeProject = async (project: ProjectSummary): Promise<void> => {
    const api = window.laipian;
    if (!api) {
      return;
    }
    const result = await api.projects.removeRecent({ projectId: project.projectId });
    if (!result.ok) {
      feedbackStore.showBanner({
        kind: 'error',
        title: '移除失败',
        message: result.error.message,
        actions: [{ label: '关闭', run: () => feedbackStore.clearBanner() }],
      });
      return;
    }
    // main 已确认移除索引：本地隐藏并给出可撤销提示（明确磁盘文件未删除）。
    setHiddenIds((ids) => [...ids, project.projectId]);
    feedbackStore.pushToast({
      kind: 'info',
      message: `已从项目库移除「${project.name}」，磁盘文件未删除。`,
      action: {
        label: '撤销',
        run: () => {
          setHiddenIds((ids) => ids.filter((id) => id !== project.projectId));
        },
      },
    });
  };

  const handleRenamed = (projectId: string, name: string): void => {
    recent.refresh();
    feedbackStore.pushToast({ kind: 'success', message: `已重命名为「${name}」。` });
    void projectId;
  };

  const searchKeyword = query.trim();

  let content: React.ReactNode;
  if (recent.state.phase === 'loading') {
    content = (
      <div className="home-loading" role="status">
        正在读取项目列表…
      </div>
    );
  } else if (recent.state.phase === 'error') {
    content = (
      <div className="home-error-card" role="alert">
        <h3>无法读取项目列表</h3>
        <p>{recent.state.error.message}</p>
        <button
          type="button"
          className="primary-button"
          onClick={recent.refresh}
          title="重新调用 projects.listRecent"
        >
          <Icon name="retry" />
          <span>重试</span>
        </button>
      </div>
    );
  } else if (projects.length === 0) {
    // 空状态（规格 2.1：首次启动 / 浏览器预览模式）。
    content = (
      <div className="home-empty">
        <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
          <rect
            x="6"
            y="12"
            width="52"
            height="40"
            rx="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <path d="M26 24 42 32 26 40Z" fill="currentColor" opacity="0.9" />
          <circle cx="12" cy="20" r="2" fill="currentColor" />
          <circle cx="12" cy="32" r="2" fill="currentColor" />
          <circle cx="12" cy="44" r="2" fill="currentColor" />
          <circle cx="52" cy="20" r="2" fill="currentColor" />
          <circle cx="52" cy="32" r="2" fill="currentColor" />
          <circle cx="52" cy="44" r="2" fill="currentColor" />
        </svg>
        <p className="home-empty-title">导入视频，开始第一次拉片</p>
        <div className="home-empty-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!hasApi}
            title={hasApi ? undefined : '需要桌面运行环境（浏览器预览模式无文件选择器）'}
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="new-project" />
            <span>新建项目</span>
          </button>
          <button
            type="button"
            className="dialog-button-secondary"
            disabled={!hasApi || openingFolder}
            title={hasApi ? undefined : '需要桌面运行环境（浏览器预览模式无目录选择器）'}
            onClick={() => void openProjectFolder()}
          >
            <Icon name="open-folder" />
            <span>打开项目文件夹</span>
          </button>
        </div>
      </div>
    );
  } else if (visibleProjects.length === 0 && searchKeyword.length > 0) {
    content = (
      <div className="home-empty home-empty--compact">
        <p className="home-empty-title">没有匹配「{searchKeyword}」的项目</p>
        <button type="button" className="dialog-button-secondary" onClick={() => setQuery('')}>
          <Icon name="close" />
          <span>清空搜索</span>
        </button>
      </div>
    );
  } else {
    content = (
      <div className="home-grid">
        {visibleProjects.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            hasApi={hasApi}
            canOpen={canOpenProject}
            openDisabledReason={openProjectDisabledReason}
            onOpen={onOpenProject}
            onRename={(p) => {
              setRenaming(p);
            }}
            onReveal={(p) => {
              void revealProject(p);
            }}
            onRemove={(p) => {
              void removeProject(p);
            }}
            onRelocate={onRelocateSource}
            onRebuildThumbnails={onRebuildThumbnails}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="home-page">
      <header className="home-topbar">
        <div className="brand">
          <BrandMark size={24} className="brand-mark" />
          <div className="home-brand-copy">
            <h1>CutSpect</h1>
            <span>视频节奏与结构分析</span>
          </div>
        </div>
        <input
          className="home-search"
          type="search"
          aria-label="搜索项目（匹配项目名或源文件名）"
          placeholder="搜索项目名或源文件名"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <div className="home-topbar-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!hasApi}
            title={hasApi ? '选择视频文件并创建项目（规格 2.3）' : '需要桌面运行环境（浏览器预览模式无文件选择器）'}
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="new-project" />
            <span>新建项目</span>
          </button>
          <button
            type="button"
            className="dialog-button-secondary"
            disabled={!hasApi || openingFolder}
            title={
              hasApi
                ? '选择已有项目文件夹（包含 project.json）直接打开'
                : '需要桌面运行环境（浏览器预览模式无目录选择器）'
            }
            onClick={() => void openProjectFolder()}
          >
            <Icon name="open-folder" />
            <span>{openingFolder ? '正在打开…' : '打开项目文件夹'}</span>
          </button>
          {/* 阶段 A 不渲染“设置”按钮：设置面板尚未交付，禁止假入口。 */}
        </div>
      </header>

      <main className="home-content">{content}</main>

      {/* 弹窗常驻挂载：关闭仅隐藏，表单暂存内存（规格 2.3 / 14）。 */}
      <NewProjectDialog
        isOpen={createOpen}
        hasApi={hasApi}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={onProjectCreated}
      />
      <RenameProjectDialog
        project={renaming}
        hasApi={hasApi}
        onClose={() => {
          setRenaming(null);
        }}
        onRenamed={handleRenamed}
      />
    </div>
  );
}
