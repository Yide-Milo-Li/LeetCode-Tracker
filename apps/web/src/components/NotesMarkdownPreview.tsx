/** Render the same CommonMark, GFM and math syntax used by the formatter. */
import React, { memo, useDeferredValue, useRef } from 'react';
import { FileText } from 'lucide-react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { translations, type Language } from '../i18n.ts';
import { CopyButton } from './CopyButton.tsx';

const plugins = [remarkGfm, remarkMath];

/** A fenced block with its language label and, when asked for, a button that copies its text. */
function CodeBlock({ language, copy, lang, children, ...props }: React.ComponentProps<'pre'> & { language?: string; copy: boolean; lang: Language }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="notes-code-block">
      {language && language !== 'math' && <span className="notes-code-language">{language}</span>}
      <pre {...props} ref={pre}>{children}</pre>
      {copy && (
        <CopyButton className="notes-code-copy" text={() => pre.current?.textContent ?? ''}
          label={lang === 'zh' ? '复制代码' : 'Copy code'} copiedLabel={lang === 'zh' ? '已复制' : 'Copied'} />
      )}
    </div>
  );
}

/**
 * Render source as React nodes without executing raw HTML or loading images.
 *
 * @param copyCode Give every fenced block a copy button.
 */
export const RenderedMarkdown = memo(function RenderedMarkdown({ content, lang, copyCode = false }: { content: string; lang: Language; copyCode?: boolean }) {
  return (
    <Markdown
      remarkPlugins={plugins}
      urlTransform={url => {
        const safe = defaultUrlTransform(url);
        return /^[a-z][a-z\d+.-]*:/i.test(safe) && !/^https?:/i.test(safe) ? '' : safe;
      }}
      components={{
        pre: ({ node: _node, children, ...props }) => {
          const child = React.Children.toArray(children).find(item => React.isValidElement<{ className?: string }>(item));
          const className = React.isValidElement<{ className?: string }>(child) ? child.props.className : '';
          const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1];
          return <CodeBlock {...props} language={language} copy={copyCode} lang={lang}>{children}</CodeBlock>;
        },
        a: ({ node: _node, href, children, ...props }) => href
          ? <a {...props} href={href} {...(href.startsWith('#')
            ? { onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              document.getElementById(href.slice(1))?.scrollIntoView?.({ block: 'nearest' });
            } }
            : { target: '_blank', rel: 'noreferrer noopener' })}>{children}</a>
          : <span>{children}</span>,
        img: ({ node: _node, src, alt }) => (
          <span className="notes-image-placeholder">{alt || (lang === 'zh' ? '图片' : 'Image')}{src ? ` (${src})` : ''}</span>
        ),
        code: ({ node: _node, className, children, ...props }) => {
          if (className?.includes('math-inline')) return <span className="notes-math-inline">{children}</span>;
          return <code {...props} className={className}>{children}</code>;
        },
      }}
    >
      {content}
    </Markdown>
  );
});

/** Defer expensive preview updates without delaying editor input. */
export function NotesMarkdownPreview({
  content,
  lang,
  showInsertTemplate = false,
  onInsertTemplate,
}: {
  content: string;
  lang: Language;
  showInsertTemplate?: boolean;
  onInsertTemplate?: () => void;
}) {
  const deferredContent = useDeferredValue(content);
  if (!content.trim()) {
    return (
      <div className="notes-preview-pane notes-preview-empty">
        <p className="nw-preview-empty-text">{translations[lang].previewEmptyNote}</p>
        {showInsertTemplate && onInsertTemplate && (
          <button
            type="button"
            className="btn btn-secondary btn-sm nw-empty-template-btn"
            onClick={onInsertTemplate}
            title={translations[lang].insertTemplateTitle}
          >
            <FileText size={13} aria-hidden="true" />
            <span>{translations[lang].insertTemplate}</span>
          </button>
        )}
      </div>
    );
  }
  return <div className="notes-preview-pane"><RenderedMarkdown content={deferredContent} lang={lang} /></div>;
}
