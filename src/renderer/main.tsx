import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 样式按“基础 → 页面 → 编辑器 → 反馈 → 主题覆盖”显式排序。
// 不再由组件内部零散引入，避免打包后旧规则落在主题覆盖层之后。
import './styles/tokens.css';
import './styles.css';
import './styles/editor.css';
import './styles/feedback.css';
// 石墨工作台覆盖层必须最后引入。
import './styles/graphite.css';
// 石墨节奏台覆盖层在石墨工作台之后引入（布局骨架：观片/读谱、可收起栏）。
import './styles/rhythm.css';
// 导出中心对话框样式（最后引入，独立作用域）。
import './styles/export.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到 #root 挂载点（index.html）');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
