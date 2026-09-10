/**
 * Accessible modal displaying the keyboard shortcuts cheat sheet for desktop power-users.
 */
import React from 'react';
import type { Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';

interface ShortcutHelpModalProps {
  lang: Language;
  onClose: () => void;
}

export function ShortcutHelpModal({ lang, onClose }: ShortcutHelpModalProps) {
  const zh = lang === 'zh';

  const shortcuts = [
    {
      category: zh ? '视图导航' : 'Navigation',
      items: [
        { key: '1', desc: zh ? '切换至「今日」' : 'Navigate to Today' },
        { key: '2', desc: zh ? '切换至「题库」' : 'Navigate to Problems' },
        { key: '3', desc: zh ? '切换至「进展」' : 'Navigate to Progress' },
      ],
    },
    {
      category: zh ? '快捷操作' : 'Quick Actions',
      items: [
        { key: '/', desc: zh ? '快速聚焦搜索框' : 'Focus catalog search' },
        { key: 'N', desc: zh ? '快速唤起手动记录' : 'Log new manual practice' },
        { key: '?', desc: zh ? '打开快捷键速查' : 'Open keyboard shortcuts' },
        { key: 'Esc', desc: zh ? '关闭弹窗 / 取消聚焦' : 'Close modal or drawer' },
      ],
    },
    {
      category: zh ? '图表与看板' : 'Dashboard & Heatmap',
      items: [
        { key: '↑ ↓ ← →', desc: zh ? '热力图日期格子游标' : 'Navigate heatmap calendar cells' },
        { key: 'Enter / Space', desc: zh ? '打开选中日期的活动抽屉' : 'Drilldown into selected date in drawer' },
      ],
    },
  ];

  return (
    <Dialog
      lang={lang}
      onClose={onClose}
      title={zh ? '键盘快捷键' : 'Keyboard Shortcuts'}
    >
      <div className="shortcut-help-container">
        <p className="shortcut-caption">
          {zh
            ? '在任何未聚焦输入框的区域直接按下按键即可触发：'
            : 'Press keys anytime when form inputs are not focused:'}
        </p>

        {shortcuts.map((section) => (
          <div key={section.category} className="shortcut-section">
            <h3 className="shortcut-category-title">{section.category}</h3>
            <ul className="shortcut-list">
              {section.items.map((item) => (
                <li key={item.key} className="shortcut-item">
                  <span className="shortcut-desc">{item.desc}</span>
                  <kbd className="shortcut-kbd">{item.key}</kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
