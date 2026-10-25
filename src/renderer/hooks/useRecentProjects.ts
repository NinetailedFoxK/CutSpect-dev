import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaipianError, ProjectSummary } from '@shared/api-types';

/**
 * 项目库最近列表的数据 hook（规格 2.2）。
 *
 * 职责：
 * - 挂载时调用 window.laipian.projects.listRecent()；
 * - 窗口重新获得焦点时静默刷新（用户可能在文件管理器里动过项目）；
 * - 显式 refresh() 供错误卡片“重试”按钮使用；
 * - 浏览器预览模式（无 window.laipian）返回空列表的 ready 态，
 *   由上层渲染“预览横幅 + 空状态”，不抛错不崩溃。
 *
 * 数据注入式设计：本 hook 只产出 RecentProjectsController，
 * 由 App 组合后传入 <Home recent={...}/>；dev demo 注入固定假数据
 * （src/renderer/dev/demo-home.tsx），正式路径不受影响。
 */

export type RecentProjectsState =
  | { phase: 'loading' }
  | { phase: 'ready'; projects: ProjectSummary[] }
  | { phase: 'error'; error: LaipianError };

export interface RecentProjectsController {
  state: RecentProjectsState;
  /** 触发重新加载：错误重试、focus 刷新共用同一入口。 */
  refresh: () => void;
}

export function useRecentProjects(): RecentProjectsController {
  const [state, setState] = useState<RecentProjectsState>({ phase: 'loading' });
  // 请求序号：refresh() 递增触发 effect 重跑，同时用于丢弃过期响应。
  const [reloadCount, setReloadCount] = useState(0);
  // 封面后台补建期间，首页需短暂轮询刷新才能拿到新生成的封面 URL（有限次，避免空转）。
  const coverBackfillRetries = useRef(0);

  const refresh = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  useEffect(() => {
    const api = window.laipian;
    if (!api) {
      // 浏览器预览模式：没有可调用的项目服务，直接进入空列表。
      setState({ phase: 'ready', projects: [] });
      return undefined;
    }
    let cancelled = false;
    const timers: number[] = [];
    // 首次加载显示 loading；已有 ready 数据时静默刷新，避免列表闪烁。
    setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    void api.projects
      .listRecent()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setState({ phase: 'ready', projects: result.data });
          // 存在"可打开但暂无封面"的项目时，main 正在后台补建封面；短暂轮询刷新，
          // 让新封面尽快出现在卡片上（最多 4 次；一旦全部有封面即停止并复位计数）。
          const pendingCover = result.data.some(
            (project) => project.coverMediaUrl === null && project.status !== 'missing',
          );
          if (pendingCover && coverBackfillRetries.current < 4) {
            coverBackfillRetries.current += 1;
            timers.push(
              window.setTimeout(() => {
                if (!cancelled) {
                  refresh();
                }
              }, 1800),
            );
          } else if (!pendingCover) {
            coverBackfillRetries.current = 0;
          }
        } else {
          setState({ phase: 'error', error: result.error });
        }
      })
      .catch((error: unknown) => {
        // 正常契约下 preload/main 已把异常兜底为 Result error；此分支纯防御。
        if (cancelled) {
          return;
        }
        setState({
          phase: 'error',
          error: {
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      cancelled = true;
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [reloadCount, refresh]);

  // 窗口重新聚焦时刷新（用户可能刚在文件管理器中移动/删除了项目）。
  useEffect(() => {
    const onFocus = (): void => {
      refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { state, refresh };
}