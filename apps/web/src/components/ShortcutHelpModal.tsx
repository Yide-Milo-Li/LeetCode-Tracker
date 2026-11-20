/**
 * Accessible modal displaying the keyboard shortcuts cheat sheet for desktop power-users.
 */
import React from 'react';
import { translations, type Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';

interface ShortcutHelpModalProps {
  lang: Language;
  onClose: () => void;
}

export function ShortcutHelpModal({ lang, onClose }: ShortcutHelpModalProps) {
  const zh = lang === 'zh';
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');

  const shortcuts = [
    {
      category: zh ? '视图导航' : 'Navigation',
      items: [
        { key: '1', desc: zh ? '切换至「今日」' : 'Navigate to Today' },
        { key: '2', desc: zh ? '切换至「题库」' : 'Navigate to Problems' },
        { key: '3', desc: zh ? '切换至「进展」' : 'Navigate to Progress' },
        { key: '4', desc: zh ? '切换至「复盘」' : 'Navigate to Notes' },
        { key: '5', desc: zh ? '切换至「收藏夹」' : 'Navigate to Favorites' },
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
      category: zh ? '复盘笔记' : 'Notes Workspace',
      caption: translations[lang].markdownMathSupported,
      items: [
        { key: isMac ? '⌘S' : 'Ctrl+S', desc: zh ? '保存当前笔记' : 'Save active note' },
        { key: isMac ? '⌘\\' : 'Ctrl+\\', desc: zh ? '切换专注模式' : 'Toggle focus mode' },
        { key: isMac ? '⌘Z' : 'Ctrl+Z', desc: zh ? '撤销编辑' : 'Undo edit' },
        { key: isMac ? '⇧⌘Z' : 'Ctrl+Y', desc: zh ? '重做编辑' : 'Redo edit' },
        { key: isMac ? '⌘B' : 'Ctrl+B', desc: zh ? '加粗 / 取消加粗' : 'Toggle bold' },
        { key: isMac ? '⌘I' : 'Ctrl+I', desc: zh ? '斜体 / 取消斜体' : 'Toggle italic' },
        { key: isMac ? '⌘E' : 'Ctrl+E', desc: zh ? '行内代码 / 代码块' : 'Inline code / code block' },
        { key: isMac ? '⌘K' : 'Ctrl+K', desc: zh ? '插入链接' : 'Insert link' },
        { key: isMac ? '⇧⌘X' : 'Ctrl+Shift+X', desc: zh ? '删除线' : 'Toggle strikethrough' },
        { key: isMac ? '⌘C / ⌘X' : 'Ctrl+C / Ctrl+X', desc: zh ? '复制 / 剪切（无选区时操作当前行）' : 'Copy / cut selection or current line' },
        { key: 'Tab / ⇧Tab', desc: zh ? '缩进 / 取消缩进' : 'Indent / outdent' },
      ],
    },
    {
      category: zh ? '图表与看板' : 'Dashboard & Heatmap',
      items: [
        { key: '↑ ↓ ← →', desc: zh ? '热力图日期格子游标' : 'Navigate heatmap calendar cells' },
        { key: 'Enter / Space', desc: zh ? '在「记录」中查看选中日期' : 'Open the selected date in Records' },
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
            ? '光标离开输入框后，可以使用导航和快捷操作键。'
            : 'Navigation and quick actions work when the cursor is outside a text field.'}
        </p>

        {shortcuts.map((section) => (
          <div key={section.category} className="shortcut-section">
            <h3 className="shortcut-category-title">{section.category}</h3>
            {section.caption && <p className="shortcut-caption">{section.caption}</p>}
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
