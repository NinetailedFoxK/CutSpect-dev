/**
 * TooltipHost（统一悬停提示）。
 *
 * 用 [data-tip] 属性驱动：任何元素加上 data-tip="动作名（快捷键）" 后，
 * 鼠标停留约 450ms 或键盘聚焦时显示提示；固定定位（fixed）并自动上下翻转，
 * 因此不会被检查器/面板的 overflow 裁切，也不遮挡鼠标所在操作点。
 *
 * 说明：
 * - 纯图标按钮应由 data-tip 提供名称（aria-label 提供无障碍名称）。
 * - 有快捷键的写成「动作名（快捷键）」；没有快捷键只写动作名。
 * - 提示本身 pointer-events:none，不干扰操作。
 */
import { useEffect, useRef, useState } from 'react';

/** 悬停多久后出现（毫秒）。 */
const DELAY_MS = 450;
/** 提示与目标之间的间距。 */
const GAP = 6;
/** 视口边缘安全距离。 */
const EDGE = 8;

interface TipState {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

export function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const timerRef = useRef<number | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const hide = () => {
      clearTimer();
      targetRef.current = null;
      setTip(null);
    };
    const findTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) {
        return null;
      }
      const el = node.closest('[data-tip]');
      return el instanceof HTMLElement ? el : null;
    };
    const place = (el: HTMLElement, text: string) => {
      const rect = el.getBoundingClientRect();
      const below = rect.bottom + GAP + 28 <= window.innerHeight || rect.top < 40;
      const x = Math.min(Math.max(rect.left + rect.width / 2, EDGE), window.innerWidth - EDGE);
      const y = below ? rect.bottom + GAP : rect.top - GAP;
      setTip({ text, x, y, below });
    };

    const onOver = (event: PointerEvent) => {
      const el = findTarget(event.target);
      if (el === null || el === targetRef.current) {
        return;
      }
      clearTimer();
      targetRef.current = el;
      setTip(null);
      const text = el.getAttribute('data-tip');
      if (text === null || text.length === 0) {
        return;
      }
      timerRef.current = window.setTimeout(() => {
        if (targetRef.current === el) {
          place(el, text);
        }
      }, DELAY_MS);
    };
    const onOut = (event: PointerEvent) => {
      const el = findTarget(event.target);
      if (el !== null && el === targetRef.current) {
        hide();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const el = findTarget(event.target);
      const text = el?.getAttribute('data-tip') ?? null;
      if (el !== null && text !== null && text.length > 0) {
        clearTimer();
        targetRef.current = el;
        place(el, text);
      }
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimer();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  if (tip === null) {
    return null;
  }
  return (
    <div
      className="lp-tooltip"
      role="tooltip"
      style={{
        left: `${tip.x}px`,
        top: `${tip.y}px`,
        transform: tip.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
    >
      {tip.text}
    </div>
  );
}