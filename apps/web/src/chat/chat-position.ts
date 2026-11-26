/**
 * Placement of the floating chat: where the collapsed launcher docks and where the panel opens.
 *
 * The launcher always rests against the left or right window edge so it can tuck out of the way;
 * the panel may sit anywhere inside the window. Both are remembered on this device only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export const LAUNCHER_SIZE = 40;
/** Gap between the revealed launcher and the window edge. */
const EDGE_GAP = 12;
/** Width of the launcher that stays on screen while it is tucked away. */
const TUCK_VISIBLE = 12;
export const PANEL_WIDTH = 420;
/** Gap around a panel that opens from the dock; a dragged panel may come closer to the edge. */
const PANEL_MARGIN = 24;
const PANEL_MIN_GAP = 8;
/** Pointer travel below this still counts as a click. */
const DRAG_THRESHOLD = 4;
const STORAGE_KEY = 'leetcode_tracker_chat_position_v1';

export interface Viewport { width: number; height: number }
/** Top-left corner in viewport pixels. */
export interface Point { left: number; top: number }
/** Edge the launcher rests on, and the distance from its bottom to the bottom of the window. */
export interface ChatDock { side: 'left' | 'right'; bottom: number }
/** `panel` is set once the user has dragged the panel; without it the panel opens beside the dock. */
export interface ChatPosition { dock: ChatDock; panel?: Point }

export const DEFAULT_CHAT_POSITION: ChatPosition = { dock: { side: 'right', bottom: 24 } };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Matches the CSS height of `.chat-panel`. */
export const panelHeight = (viewport: Viewport) => Math.min(620, viewport.height - 2 * PANEL_MARGIN);

/** Where the launcher is drawn; a tucked launcher keeps only a sliver inside the window. */
export function launcherPoint(dock: ChatDock, viewport: Viewport, tucked: boolean): Point {
  const inset = tucked ? TUCK_VISIBLE - LAUNCHER_SIZE : EDGE_GAP;
  return {
    left: dock.side === 'left' ? inset : viewport.width - LAUNCHER_SIZE - inset,
    top: clamp(viewport.height - dock.bottom - LAUNCHER_SIZE, EDGE_GAP, viewport.height - LAUNCHER_SIZE - EDGE_GAP),
  };
}

/** Keeps a launcher that is being dragged fully inside the window. */
export const clampLauncher = (point: Point, viewport: Viewport): Point => ({
  left: clamp(point.left, 0, viewport.width - LAUNCHER_SIZE),
  top: clamp(point.top, 0, viewport.height - LAUNCHER_SIZE),
});

/** Dock for a launcher released at `point`: the nearer edge, at the height it was dropped. */
export const dockAt = (point: Point, viewport: Viewport): ChatDock => ({
  side: point.left + LAUNCHER_SIZE / 2 < viewport.width / 2 ? 'left' : 'right',
  bottom: clamp(viewport.height - point.top - LAUNCHER_SIZE, EDGE_GAP, viewport.height - LAUNCHER_SIZE - EDGE_GAP),
});

export const clampPanel = (point: Point, viewport: Viewport): Point => ({
  left: clamp(point.left, PANEL_MIN_GAP, viewport.width - PANEL_WIDTH - PANEL_MIN_GAP),
  top: clamp(point.top, PANEL_MIN_GAP, viewport.height - panelHeight(viewport) - PANEL_MIN_GAP),
});

/** Where the panel opens: the spot it was dragged to, otherwise beside the dock with bottoms aligned. */
export function panelPoint(position: ChatPosition, viewport: Viewport): Point {
  if (position.panel) return clampPanel(position.panel, viewport);
  const height = panelHeight(viewport);
  return {
    left: position.dock.side === 'left' ? PANEL_MARGIN : viewport.width - PANEL_WIDTH - PANEL_MARGIN,
    top: clamp(viewport.height - position.dock.bottom - height, PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
  };
}

/** Dock for a panel at `point`, so the launcher reappears on the panel's side when it closes. */
export const dockForPanel = (point: Point, viewport: Viewport): ChatDock => ({
  side: point.left + PANEL_WIDTH / 2 < viewport.width / 2 ? 'left' : 'right',
  bottom: clamp(viewport.height - point.top - panelHeight(viewport), EDGE_GAP, viewport.height - LAUNCHER_SIZE - EDGE_GAP),
});

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the remembered placement; anything malformed falls back to the default corner. */
function loadPosition(): ChatPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ChatPosition> | null;
    const dock = stored?.dock;
    if (!dock || (dock.side !== 'left' && dock.side !== 'right') || !isNumber(dock.bottom)) return DEFAULT_CHAT_POSITION;
    const panel = stored.panel;
    return {
      dock: { side: dock.side, bottom: dock.bottom },
      ...(panel && isNumber(panel.left) && isNumber(panel.top) ? { panel: { left: panel.left, top: panel.top } } : {}),
    };
  } catch {
    return DEFAULT_CHAT_POSITION;
  }
}

const readViewport = (): Viewport => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: document.documentElement.clientHeight || window.innerHeight,
});

/**
 * Remembered chat placement plus the live window size.
 *
 * Stored values are kept as dropped and clamped only when drawn, so shrinking the window does not
 * lose a placement that fits again once the window grows back.
 */
export function useChatPosition() {
  const [position, setPosition] = useState(loadPosition);
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const save = useCallback((next: ChatPosition) => {
    setPosition(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable; the placement then lasts for this session only.
    }
  }, []);

  return { position, viewport, save };
}

/**
 * Pointer drag that still lets a plain click through.
 *
 * `start` takes the element's current top-left corner; `onMove` and `onEnd` receive that corner
 * shifted by the pointer travel. Listeners live on the window so the drag survives the pointer
 * outrunning the element. After a drag, `consumeClick` reports `true` once so the release does not
 * also activate the element.
 */
export function useDrag(handlers: { onMove: (point: Point) => void; onEnd: (point: Point) => void }) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;
  const suppressClick = useRef(false);
  const release = useRef<(() => void) | null>(null);

  useEffect(() => () => release.current?.(), []);

  const start = useCallback((event: React.PointerEvent, origin: Point) => {
    if (event.button !== 0) return;
    release.current?.();
    const from = { x: event.clientX, y: event.clientY };
    let moved = false;
    let last = origin;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - from.x;
      const dy = next.clientY - from.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        // Stops text selection and keeps the grabbing cursor while the pointer crosses the page.
        document.documentElement.classList.add('chat-dragging');
      }
      last = { left: origin.left + dx, top: origin.top + dy };
      latest.current.onMove(last);
    };
    const stop = () => {
      release.current?.();
      if (!moved) return;
      suppressClick.current = true;
      // The click, if any, follows the release in the same task; never swallow a later one.
      setTimeout(() => { suppressClick.current = false; }, 0);
      setDragging(false);
      latest.current.onEnd(last);
    };
    release.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.documentElement.classList.remove('chat-dragging');
      release.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, []);

  const consumeClick = useCallback(() => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }, []);

  return { dragging, start, consumeClick };
}
