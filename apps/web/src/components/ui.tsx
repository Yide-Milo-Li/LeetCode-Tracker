/**
 * Shared desktop controls and accessible overlays.
 * All controls render genuine DOM elements and respect desktop accessibility requirements:
 * keyboard focus trapping, visible focus rings, Escape dismissals, screen-reader semantics,
 * and graceful reduced-motion support.
 */
import React, {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  type ComponentType,
} from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Info, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Language } from '../i18n.ts';

/**
 * Render a consistent contextual page header without promoting child views into navigation.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; run: () => void };
}) {
  return (
    <>
      {back && (
        <button className="back-link" onClick={back.run}>
          ← {back.label}
        </button>
      )}
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          {description && (
            <p
              key={typeof description === 'string' ? description : undefined}
              className="page-description"
            >
              {description}
            </p>
          )}
        </div>
        <div className="action-row">{actions}</div>
      </header>
    </>
  );
}

/**
 * Keep failures and status visible without replacing the entire view.
 */
export function Feedback({
  children,
  tone = 'error',
  retry,
}: {
  children: ReactNode;
  tone?: 'error' | 'success' | 'warning' | 'info';
  retry?: { label: string; run: () => void };
}) {
  return (
    <div className={`feedback ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertCircle size={16} aria-hidden="true" />
      <div>{children}</div>
      {retry && (
        <button className="btn btn-secondary btn-sm" onClick={retry.run}>
          {retry.label}
        </button>
      )}
    </div>
  );
}

/**
 * Preserve a readable, labelled field; callers supply controlled inputs and error descriptions.
 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * Paginate with bounded actions and preserve the existing configurable page-size contract.
 */
export function Pagination({
  page,
  total,
  limit,
  onPage,
  onLimit,
  lang,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
  onLimit?: (limit: number) => void;
  lang: Language;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span>
        {lang === 'zh'
          ? `第 ${page} / ${pages} 页 · 共 ${total} 条`
          : `Page ${page} of ${pages} · ${total} records`}
      </span>
      <div className="action-row">
        {onLimit && (
          <select
            aria-label={lang === 'zh' ? '每页条数' : 'Page size'}
            value={limit}
            onChange={(e) => onLimit(Number(e.target.value))}
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / {lang === 'zh' ? '页' : 'page'}
              </option>
            ))}
          </select>
        )}
        <IconButton icon={ChevronLeft} label={lang === 'zh' ? '上一页' : 'Previous'} disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <IconButton icon={ChevronRight} label={lang === 'zh' ? '下一页' : 'Next'} disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </div>
    </div>
  );
}

type FloatingSide = 'top' | 'right' | 'bottom' | 'left';
/** Cross-axis alignment for top/bottom placement; side placements always center vertically. */
type FloatingAlign = 'center' | 'start' | 'end';

/**
 * Compute viewport coordinates for floating content next to an anchor.
 * Flips to the opposite side when the preferred side overflows, then clamps inside the viewport.
 * Pure apart from reading the current viewport size.
 */
function placeFloating(
  a: DOMRect,
  f: DOMRect,
  side: FloatingSide,
  align: FloatingAlign = 'center',
  gap = 8,
): { left: number; top: number } {
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  // The viewport margin stays 8px even when the anchor gap is tighter.
  const edge = 8;
  let left = align === 'start' ? a.left : align === 'end' ? a.right - f.width : a.left + (a.width - f.width) / 2;
  let top = a.bottom + gap;
  if (side === 'right' || side === 'left') {
    left = side === 'right' ? a.right + gap : a.left - f.width - gap;
    if (left + f.width > width - edge) left = a.left - f.width - gap;
    if (left < edge) left = a.right + gap;
    top = a.top + (a.height - f.height) / 2;
  } else {
    top = side === 'top' ? a.top - f.height - gap : a.bottom + gap;
    if (top < edge) top = a.bottom + gap;
    if (top + f.height > height - edge) top = a.top - f.height - gap;
  }
  return {
    left: Math.max(edge, Math.min(left, width - f.width - edge)),
    top: Math.max(edge, Math.min(top, height - f.height - edge)),
  };
}

/** Measure only open floating content; flip and clamp it within desktop viewport edges. */
function useFloatingPosition(
  open: boolean,
  anchor: React.RefObject<HTMLElement | null>,
  floating: React.RefObject<HTMLDivElement | null>,
  side: FloatingSide,
) {
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchor.current || !floating.current) return;
      setPosition(
        placeFloating(anchor.current.getBoundingClientRect(), floating.current.getBoundingClientRect(), side),
      );
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [open, side, anchor, floating]);
  return position;
}

/**
 * True when the runtime implements the native Popover API.
 * Feature-detects on the prototype, as the popover guidance requires; jsdom and very old
 * WebViews take the manual fallback in `useActionPopover`.
 */
function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
}

/** Whether `root` contains a native popover that is currently showing. */
function hasOpenPopover(root: Element | null): boolean {
  return supportsPopover() && !!root?.querySelector(':popover-open');
}

/** Whether `node` sits inside a native popover that is currently hidden. */
function isInsideClosedPopover(node: Element): boolean {
  return supportsPopover() && !!node.closest('[popover]:not(:popover-open)');
}

export interface ActionPopover {
  /** Whether the panel is showing; mirrors the native `toggle` event when popovers are supported. */
  open: boolean;
  /** Hide the panel. Native popovers return focus to the trigger if focus was inside the panel. */
  close: () => void;
  /** Render the panel's children only while this is true (always true for native popovers). */
  rendered: boolean;
  triggerProps: {
    ref: React.RefObject<HTMLButtonElement | null>;
    'aria-expanded': boolean;
    'aria-controls'?: string;
    popoverTarget?: string;
    onClick?: () => void;
  };
  panelProps: {
    ref: (node: HTMLDivElement | null) => void;
    id: string;
    popover?: 'auto';
  };
}

/**
 * Button-revealed action panel (a disclosure, not an ARIA menu: no arrow-key contract).
 *
 * Native path: `popover="auto"` + `popovertarget` give top-layer rendering, light dismiss,
 * Escape and focus return from the browser. The panel is placed from script because CSS anchor
 * positioning is not available in every target WebView (macOS 14 ships Safari 17).
 * Fallback path (no Popover API): the panel mounts only while open, and outside clicks / Escape
 * are handled manually.
 */
export function useActionPopover({ align = 'start' }: { align?: 'start' | 'end' } = {}): ActionPopover {
  const id = useId();
  const [native] = useState(supportsPopover);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Track the element in state too: panels can mount after the hook (e.g. a toolbar that only
  // renders once a problem is selected), and the native listeners must bind to that element.
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null);
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanelNode(node);
  }, []);

  const close = useCallback(() => {
    const panel = panelRef.current;
    if (native) {
      if (panel?.matches(':popover-open')) panel.hidePopover();
    } else {
      setOpen(false);
    }
  }, [native]);

  // Native: follow the browser's open state and keep the top-layer panel attached to its trigger.
  useEffect(() => {
    const panel = panelNode;
    if (!native) return;
    if (!panel) {
      // An unmounted panel cannot be open; keep aria-expanded truthful.
      setOpen(false);
      return;
    }
    let frame = 0;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger || !panel.matches(':popover-open')) return;
      const { left, top } = placeFloating(
        trigger.getBoundingClientRect(),
        panel.getBoundingClientRect(),
        'bottom',
        align,
        4,
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    // The panel is shown synchronously after `beforetoggle`; the frame callback runs before the
    // first paint, so the panel never flashes at the default centered popover position.
    const beforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') frame = requestAnimationFrame(place);
    };
    const toggle = (event: Event) => setOpen((event as ToggleEvent).newState === 'open');
    panel.addEventListener('beforetoggle', beforeToggle);
    panel.addEventListener('toggle', toggle);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      panel.removeEventListener('beforetoggle', beforeToggle);
      panel.removeEventListener('toggle', toggle);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [native, align, panelNode]);

  // Fallback: emulate light dismiss and Escape while the panel is mounted.
  useEffect(() => {
    if (native || !open) return;
    const handleDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture phase + stopPropagation keeps an enclosing Dialog open, matching native popovers.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', handleDown);
    window.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [native, open]);

  return {
    open,
    close,
    rendered: native || open,
    triggerProps: {
      ref: triggerRef,
      'aria-expanded': open,
      // Only reference the panel while it exists in the DOM.
      'aria-controls': native || open ? id : undefined,
      ...(native ? { popoverTarget: id } : { onClick: () => setOpen((value) => !value) }),
    },
    panelProps: { ref: attachPanel, id, ...(native ? { popover: 'auto' as const } : {}) },
  };
}

/**
 * Accessible desktop tooltip anchored to interactive controls.
 * Shows on hover or focus, dismisses immediately on Escape, and attaches aria-describedby.
 */
export function Tooltip({
  content,
  text,
  shortcut,
  children,
  side,
  position = 'right',
  disabled = false,
}: {
  content?: ReactNode;
  text?: ReactNode;
  shortcut?: string;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  position?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
}) {
  const tooltipContent = content ?? text;
  const placement = side ?? position;
  const anchorRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const coordinates = useFloatingPosition(open && !disabled, anchorRef, bubbleRef, placement);

  useEffect(() => {
    if (!open || disabled) return;
    const dismiss = () => setOpen(false);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('hashchange', dismiss);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('hashchange', dismiss);
    };
  }, [open, disabled]);

  return (
    <div
      ref={anchorRef}
      className="tooltip-wrapper"
      onMouseEnter={() => !disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => !disabled && setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {React.cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby': open && !disabled ? id : undefined,
      })}
      {open && !disabled && tooltipContent && createPortal(
        <div ref={bubbleRef} id={id} role="tooltip" className="tooltip-bubble" style={coordinates}>
          <span>{tooltipContent}</span>
          {shortcut && <kbd className="tooltip-shortcut">{shortcut}</kbd>}
        </div>,
        anchorRef.current?.closest('[data-overlay-host]') ?? document.body,
      )}
    </div>
  );
}

/**
 * Accessible contextual popover triggered by click.
 * Used for on-demand details like recommendation rationale.
 * Dismissible via outside click or Escape key, cleanly returning focus to trigger.
 */
export function InfoPopover({
  label,
  title,
  ariaLabel,
  content,
  children,
  side = 'bottom',
}: {
  label?: string;
  title?: string;
  ariaLabel?: string;
  content?: ReactNode;
  children?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const popoverLabel = label ?? title ?? ariaLabel ?? 'Details';
  const popoverContent = content ?? children;
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const coordinates = useFloatingPosition(open, triggerRef, popoverRef, side);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const handleDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('hashchange', dismiss);
    document.addEventListener('mousedown', handleDown);
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('hashchange', dismiss);
      document.removeEventListener('mousedown', handleDown);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [open]);

  return (
    <div className="info-popover-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon info-trigger"
        aria-label={popoverLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Info size={18} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          id={id}
          ref={popoverRef}
          role="region"
          aria-label={popoverLabel}
          className="info-popover-card"
          style={coordinates}
          tabIndex={-1}
        >
          <div className="info-popover-content">{popoverContent}</div>
        </div>,
        triggerRef.current?.closest('[data-overlay-host]') ?? document.body,
      )}
    </div>
  );
}

/**
 * Standard accessible icon button with >=38px clickable touch/pointer area.
 */
export function IconButton({
  icon: IconComponent,
  label,
  shortcut,
  onClick,
  disabled = false,
  className = '',
  size = 18,
  tooltipSide = 'top',
  showTooltip = true,
}: {
  icon: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  label: string;
  shortcut?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  size?: number;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  showTooltip?: boolean;
}) {
  const button = (
    <button
      type="button"
      className={`btn-icon ${className}`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <IconComponent size={size} aria-hidden="true" />
    </button>
  );

  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide} disabled={!showTooltip || disabled}>
      {button}
    </Tooltip>
  );
}

/** Editors route late responses to recovery as soon as an exit starts, before visual unmount. */
export const DialogClosingContext = React.createContext<React.RefObject<boolean>>({ current: false });

/**
 * Trap focus, inert the background, animate smoothly, and restore the trigger.
 * Dismissal never changes saved data.
 */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  lang,
  drawer = false,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  lang: Language;
  drawer?: boolean;
  wide?: boolean;
  /** A pending transaction may require this dialog to stay open until it settles. */
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [isClosing, setIsClosing] = useState(false);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;

  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closedRef = useRef(false);

  /** Finish once; route changes may supersede an in-flight exit animation. */
  const finishClose = useCallback(() => {
    clearTimeout(exitTimer.current);
    if (closedRef.current) return;
    closedRef.current = true;
    closingRef.current = true;
    closeRef.current();
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current || closeDisabledRef.current) return;
    closingRef.current = true;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      finishClose();
      return;
    }
    // Keep background inert and focus trapped until the host actually unmounts.
    setIsClosing(true);
    exitTimer.current = setTimeout(finishClose, 160);
  }, [finishClose]);

  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) {
    host.current = document.createElement('div');
    host.current.dataset.overlayHost = 'true';
  }

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const node = host.current!;
    document.body.appendChild(node);
    const siblings = Array.from(document.body.children).filter((n) => n !== node) as HTMLElement[];
    const previous = siblings.map((n) => n.inert);
    siblings.forEach((n) => {
      n.inert = true;
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const targets = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ) ?? [],
      ).filter(
        (n) =>
          !n.closest('[hidden]') &&
          !n.matches(':disabled') &&
          // Closed rule editors must not trap focus in an invisible input.
          (!n.closest('details:not([open])') || n.tagName === 'SUMMARY') &&
          // Hidden action panels stay mounted as native popovers; skip their items too.
          !isInsideClosedPopover(n),
      );

    const focusTimer = setTimeout(() => (targets()[0] ?? panel.current)?.focus(), 0);

    const keydown = (event: KeyboardEvent) => {
      if (
        document
          .querySelectorAll('[data-overlay-host]')
          ?.item(document.querySelectorAll('[data-overlay-host]').length - 1) !== node
      )
        return;
      if (event.key === 'Escape') {
        // Let the browser close an open action panel first; cancelling this keydown would
        // suppress the popover's close request and dismiss the whole dialog instead.
        if (hasOpenPopover(panel.current)) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
      if (event.key === 'Tab') {
        const list = targets();
        const first = list[0],
          last = list.at(-1);
        if (!first) {
          event.preventDefault();
          panel.current?.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', keydown);

    // A browser history change must immediately unmount without delay
    const openedHash = window.location.hash;
    const locationChanged = () => {
      if (window.location.hash !== openedHash) finishClose();
    };
    window.addEventListener('hashchange', locationChanged);

    return () => {
      clearTimeout(focusTimer);
      clearTimeout(exitTimer.current);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('hashchange', locationChanged);
      siblings.forEach((n, i) => {
        n.inert = previous[i];
      });
      document.body.style.overflow = overflow;
      node.remove();
      if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus();
    };
  }, [requestClose, finishClose]);

  return createPortal(
    <DialogClosingContext.Provider value={closingRef}>
      <div
        className={`overlay-backdrop ${drawer ? 'is-drawer' : ''} ${isClosing ? 'is-closing' : ''}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
      >
        <div
          ref={panel}
          className={`overlay-panel ${wide ? 'wide-panel' : ''} ${isClosing ? 'is-closing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <header className="overlay-header">
            <h2 id={titleId}>{title}</h2>
            <button
              className="btn-icon"
              aria-label={lang === 'zh' ? '关闭' : 'Close'}
              onClick={requestClose}
              disabled={closeDisabled}
            >
              <X size={20} />
            </button>
          </header>
          <div className="overlay-body">{children}</div>
          {footer && <footer className="overlay-footer">{footer}</footer>}
        </div>
      </div>
    </DialogClosingContext.Provider>,
    host.current,
  );
}
