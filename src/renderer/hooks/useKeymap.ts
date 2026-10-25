import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_KEYMAP, findConflicts, resolveKeymap } from '@shared/keymap';
import type { CommandId, KeyConflict } from '@shared/keymap';

/**
 * 快捷键状态（v1.1 需求 6.3）：默认键位 + 用户覆盖（全局 userData/settings.json）。
 *
 * - 挂载时从 main 读取覆盖项并合并为生效键位；
 * - rebind / resetCommand / resetAll 写回 main（main 会再次校验并返回采纳结果）；
 * - conflicts 由当前生效键位推导，供速查面板标红提示。
 */

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

export interface KeymapController {
  keymap: Record<CommandId, string>;
  isMac: boolean;
  conflicts: readonly KeyConflict[];
  loaded: boolean;
  rebind(id: CommandId, binding: string): void;
  resetCommand(id: CommandId): void;
  resetAll(): void;
}

export function useKeymap(): KeymapController {
  const isMac = useMemo(() => isMacPlatform(), []);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    let cancelled = false;
    const api = window.laipian;
    if (!api?.settings) {
      setLoaded(true);
      return undefined;
    }
    void api.settings
      .get()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setOverrides(result.data.keymap);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keymap = useMemo(() => resolveKeymap(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(keymap), [keymap]);

  const persist = useCallback((next: Record<string, string>) => {
    setOverrides(next);
    const api = window.laipian;
    void api?.settings
      ?.set({ settings: { keymap: next } })
      .then((result) => {
        // 采纳 main 侧校验后的结果（非法条目会被丢弃）。
        if (result.ok) {
          setOverrides(result.data.keymap);
        }
      })
      .catch(() => undefined);
  }, []);

  const rebind = useCallback(
    (id: CommandId, binding: string) => {
      const next = { ...overridesRef.current };
      if (binding === DEFAULT_KEYMAP[id]) {
        delete next[id];
      } else {
        next[id] = binding;
      }
      persist(next);
    },
    [persist],
  );

  const resetCommand = useCallback(
    (id: CommandId) => {
      const next = { ...overridesRef.current };
      delete next[id];
      persist(next);
    },
    [persist],
  );

  const resetAll = useCallback(() => persist({}), [persist]);

  return { keymap, isMac, conflicts, loaded, rebind, resetCommand, resetAll };
}