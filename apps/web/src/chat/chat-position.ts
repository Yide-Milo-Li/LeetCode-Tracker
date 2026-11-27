/**
 * Placement of the floating chat: where the collapsed launcher docks and where the panel opens.
 *
 * The launcher always rests against one of the four window edges so it can shrink out of the way;
 * the panel may sit anywhere inside the window. Both are remembered on this device only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export const LAUNCHER_SIZE = 40;
/** Gap between the revealed launcher and the window edge. */
const EDGE_GAP = 12;
export const PANEL_WIDTH = 420;
/** Width of the enlarged panel, for reading code and long answers. */
const PANEL_WIDTH_LARGE = 720;
/** Gap around a panel that opens from the dock; a dragged panel may come closer to the edge. */
const PANEL_MARGIN = 24;
const PANEL_MIN_GAP = 8;
/** Pointer travel below this still counts as a click. */
const DRAG_THRESHOLD = 4;
const STORAGE_KEY = 'leetcode_tracker_chat_position_v1';

export interface Viewport { width: number; height: number }
/** Top-left corner in viewport pixels. */
export interface Point { left: number; top: number }
/**
 * Edge the launcher rests on and where along it: on a side edge, the distance from its bottom to
 * the bottom of the window; on the top or bottom edge, the distance from its left to the left of
 * the window.
 */
export type ChatDock =
  | { side: 'left' | 'right'; bottom: number }
  | { side: 'top' | 'bottom'; left: number };
/**
 * `panel` is set once the user has dragged the panel; without it the panel opens beside the dock.
 * `large` is the enlarged panel, which fills the window height.
 */
export interface ChatPosition { dock: ChatDock; panel?: Point; large?: boolean }

export const DEFAULT_CHAT_POSITION: ChatPosition = { dock: { side: 'right', bottom: 24 } };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Matches the CSS height of `.chat-panel`. */
export const panelHeight = (viewport: Viewport, large = false) =>
  large ? viewport.height - 2 * PANEL_MARGIN : Math.min(620, viewport.height - 2 * PANEL_MARGIN);

/** Matches the CSS width of `.chat-panel`. */
export const panelWidth = (viewport: Viewport, large = false) =>
  Math.min(large ? PANEL_WIDTH_LARGE : PANEL_WIDTH, viewport.width - 2 * PANEL_MARGIN);

/**
 * Where the launcher is drawn. Tucked, it sits flush against its edge, where it is drawn as a thin
 * bar; its box stays in place so the bar can be hovered, clicked and dragged.
 */
export function launcherPoint(dock: ChatDock, viewport: Viewport, tucked: boolean): Point {
  const inset = tucked ? 0 : EDGE_GAP;
  if ('left' in dock) {
    return {
      left: clamp(dock.left, EDGE_GAP, viewport.width - LAUNCHER_SIZE - EDGE_GAP),
      top: dock.side === 'top' ? inset : viewport.height - LAUNCHER_SIZE - inset,
    };
  }
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

/** Dock for a launcher released at `point`: the nearest of the four edges, at the spot it was dropped. */
export function dockAt(point: Point, viewport: Viewport): ChatDock {
  const x = point.left + LAUNCHER_SIZE / 2;
  const y = point.top + LAUNCHER_SIZE / 2;
  const toSide = Math.min(x, viewport.width - x);
  const toTopOrBottom = Math.min(y, viewport.height - y);
  if (toTopOrBottom < toSide) {
    return dockOnEdge(y < viewport.height / 2 ? 'top' : 'bottom', point.left, viewport);
  }
  return dockOnEdge(x < viewport.width / 2 ? 'left' : 'right', point.top, viewport);
}

function dockOnEdge(side: ChatDock['side'], offset: number, viewport: Viewport): ChatDock {
  if (side === 'top' || side === 'bottom') {
    return { side, left: clamp(offset, EDGE_GAP, viewport.width - LAUNCHER_SIZE - EDGE_GAP) };
  }
  return { side, bottom: clamp(viewport.height - offset - LAUNCHER_SIZE, EDGE_GAP, viewport.height - LAUNCHER_SIZE - EDGE_GAP) };
}

export const clampPanel = (point: Point, viewport: Viewport, large = false): Point => ({
  left: clamp(point.left, PANEL_MIN_GAP, viewport.width - panelWidth(viewport, large) - PANEL_MIN_GAP),
  top: clamp(point.top, PANEL_MIN_GAP, viewport.height - panelHeight(viewport, large) - PANEL_MIN_GAP),
});

const EDGE_PUSH_PX = 32;
const EDGE_HOLD_MS = 450;

interface DragGesture {
  move: (raw: Point, previous: Point, event: PointerEvent) => void;
  cancel: () => void;
}

/** Tracks one header drag. At the physical screen edge a held pointer can stop emitting moves. */
export function panelEdgeHold(viewport: Viewport, large: boolean, onTuck: (dock: ChatDock, panel: Point) => void): DragGesture {
  let hold: { side: ChatDock['side']; peak: number; along: number; timer: ReturnType<typeof setTimeout> } | undefined;
  function cancel() {
    if (hold) clearTimeout(hold.timer);
    hold = undefined;
  }
  function move(raw: Point, previous: Point, pointer: PointerEvent) {
    const panel = clampPanel(raw, viewport, large);
    const x = raw.left - panel.left;
    const y = raw.top - panel.top;
    const horizontal = Math.abs(x) >= Math.abs(y);
    const side = horizontal ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'top' : 'bottom');
    const depth = Math.abs(horizontal ? x : y);
    const along = horizontal ? pointer.clientY : pointer.clientX;
    if (hold) {
      if (hold.side === side && depth > 0 && depth >= hold.peak - 5 && Math.abs(along - hold.along) <= 12) {
        hold.peak = Math.max(hold.peak, depth);
        return;
      }
      cancel();
    }
    const dx = raw.left - previous.left;
    const dy = raw.top - previous.top;
    const outward = horizontal ? Math.sign(x) * dx : Math.sign(y) * dy;
    if (outward <= Math.abs(horizontal ? dy : dx)) return;
    const remaining = horizontal
      ? (x < 0 ? pointer.clientX : viewport.width - pointer.clientX)
      : (y < 0 ? pointer.clientY : viewport.height - pointer.clientY);
    // A grab close to the leading edge (especially the header at the top) can run out of travel.
    if (depth < EDGE_PUSH_PX && !(depth >= 6 && remaining <= 2)) return;
    hold = { side, peak: depth, along, timer: setTimeout(() => {
      hold = undefined;
      onTuck(dockOnEdge(side, along - LAUNCHER_SIZE / 2, viewport), panel);
    }, EDGE_HOLD_MS) };
  }
  return { move, cancel };
}

/** Where the panel opens: the spot it was dragged to, otherwise at the dock's edge, aligned with the launcher. */
export function panelPoint(position: ChatPosition, viewport: Viewport): Point {
  if (position.panel) return clampPanel(position.panel, viewport, position.large);
  const height = panelHeight(viewport, position.large);
  const width = panelWidth(viewport, position.large);
  const { dock } = position;
  if ('left' in dock) {
    return {
      left: clamp(dock.left, PANEL_MARGIN, viewport.width - width - PANEL_MARGIN),
      top: dock.side === 'top' ? PANEL_MARGIN : Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
    };
  }
  return {
    left: dock.side === 'left' ? PANEL_MARGIN : viewport.width - width - PANEL_MARGIN,
    top: clamp(viewport.height - dock.bottom - height, PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
  };
}

/**
 * Dock for a panel dragged to `point`, so the launcher reappears next to the panel when it closes.
 *
 * The launcher stays on the kind of edge it was on: a top or bottom dock follows the panel's left
 * edge, a side dock follows its bottom edge. The panel fills most of the window height, so its
 * distance to the top and bottom says little about where the user wants the launcher.
 */
export function dockForPanel(point: Point, viewport: Viewport, current: ChatDock, large = false): ChatDock {
  const height = panelHeight(viewport, large);
  if (current.side === 'top' || current.side === 'bottom') {
    return {
      side: point.top + height / 2 < viewport.height / 2 ? 'top' : 'bottom',
      left: clamp(point.left, EDGE_GAP, viewport.width - LAUNCHER_SIZE - EDGE_GAP),
    };
  }
  return {
    side: point.left + panelWidth(viewport, large) / 2 < viewport.width / 2 ? 'left' : 'right',
    bottom: clamp(viewport.height - point.top - height, EDGE_GAP, viewport.height - LAUNCHER_SIZE - EDGE_GAP),
  };
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the remembered placement; anything malformed falls back to the default corner. */
function loadPosition(): ChatPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ChatPosition> | null;
    const raw = stored?.dock as { side?: unknown; bottom?: unknown; left?: unknown } | undefined;
    let dock: ChatDock;
    if ((raw?.side === 'left' || raw?.side === 'right') && isNumber(raw.bottom)) dock = { side: raw.side, bottom: raw.bottom };
    else if ((raw?.side === 'top' || raw?.side === 'bottom') && isNumber(raw.left)) dock = { side: raw.side, left: raw.left };
    else return DEFAULT_CHAT_POSITION;
    const panel = stored?.panel;
    return {
      dock,
      ...(panel && isNumber(panel.left) && isNumber(panel.top) ? { panel: { left: panel.left, top: panel.top } } : {}),
      ...(stored?.large === true ? { large: true } : {}),
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
export function useDrag(handlers: { onMove: (point: Point) => void; onEnd: (point: Point) => void }, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;
  const suppressClick = useRef(false);
  const release = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => release.current?.(), []);
  useEffect(() => enabled ? cancel : undefined, [enabled, cancel]);

  const start = useCallback((event: React.PointerEvent, origin: Point, gesture?: DragGesture) => {
    if (!enabled || event.button !== 0 || release.current) return;
    const pointerId = event.pointerId;
    const from = { x: event.clientX, y: event.clientY };
    let moved = false;
    let last = origin;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const dx = next.clientX - from.x;
      const dy = next.clientY - from.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        // Stops text selection and keeps the grabbing cursor while the pointer crosses the page.
        document.documentElement.classList.add('chat-dragging');
      }
      const previous = last;
      last = { left: origin.left + dx, top: origin.top + dy };
      latest.current.onMove(last);
      gesture?.move(last, previous, next);
    };
    const stop = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      release.current?.();
      if (!moved) return;
      suppressClick.current = true;
      // The click, if any, follows the release in the same task; never swallow a later one.
      setTimeout(() => { suppressClick.current = false; }, 0);
      latest.current.onEnd(last);
    };
    const releaseDrag = () => {
      gesture?.cancel();
      if (moved) setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', releaseDrag);
      window.removeEventListener('resize', releaseDrag);
      document.documentElement.classList.remove('chat-dragging');
      release.current = null;
    };
    release.current = releaseDrag;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', releaseDrag);
    window.addEventListener('resize', releaseDrag);
  }, [enabled]);

  const consumeClick = useCallback(() => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }, []);

  return { dragging, start, cancel, consumeClick };
}
