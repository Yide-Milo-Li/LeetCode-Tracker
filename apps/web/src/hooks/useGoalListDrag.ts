import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

/** Preview the destination while dragging. Only a drop inside the list changes the draft. */
export function useGoalListDrag(ids: string[], disabled: boolean, move: (from: number, to: number) => void,
  virtual: Virtualizer<HTMLElement, HTMLLIElement> | undefined, pin: (index: number) => void) {
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), [ids, disabled]);

  return (event: ReactPointerEvent<HTMLElement>, from: number) => {
    if (disabled || ids.length < 2 || cancel.current || !event.isPrimary || event.button !== 0) return;
    const handle: HTMLElement = event.currentTarget;
    const row = handle.closest('li')!;
    const list = row.parentElement!;
    const rows = virtual ? [] : Array.from(list.children) as HTMLElement[];
    const pointer = event.pointerId;
    const startY = event.clientY;
    const startScroll = list.scrollTop;
    const listeners = new window.AbortController();
    const options = { signal: listeners.signal };
    let x = event.clientX;
    let y = startY;
    let to = from;
    let frame = 0;
    let lastTime = 0;
    let dragging = false;
    let marker: HTMLElement | null = null;

    function insertionIndex(localY: number) {
      if (virtual) {
        const item = virtual.getVirtualItemForOffset(localY);
        return item ? item.index + Number(localY >= item.start + item.size / 2) : from;
      }
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const candidate = rows[mid];
        if (localY < candidate.offsetTop + candidate.offsetHeight / 2) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    function position(rect: DOMRect) {
      const localY = Math.max(0, Math.min(rect.height, y - rect.top)) + list.scrollTop - list.clientTop;
      const insertion = insertionIndex(localY);
      to = insertion > from ? insertion - 1 : insertion;
      const target = to === from ? null : virtual ? list.querySelector<HTMLElement>(`[data-index="${to}"]`) : rows[to];
      if (target !== marker) {
        if (marker) delete marker.dataset.drop;
        marker = target;
        if (marker) marker.dataset.drop = to < from ? 'before' : 'after';
      }
      const firstTop = virtual ? 0 : rows[0].offsetTop;
      const lastBottom = virtual ? virtual.getTotalSize() : rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight;
      const shift = Math.max(firstTop - row.offsetTop, Math.min(lastBottom - row.offsetTop - row.offsetHeight,
        y - startY + list.scrollTop - startScroll));
      row.style.translate = `0 ${shift}px`;
    }

    function tick(time: number) {
      const rect = list.getBoundingClientRect();
      const edge = Math.min(48, rect.height / 3);
      const distance = y < rect.top + edge ? y - rect.top - edge : Math.max(0, y - rect.bottom + edge);
      if (edge && distance && x >= rect.left && x <= rect.right) {
        list.scrollTop += Math.max(-1, Math.min(1, distance / edge)) * Math.min(time - lastTime, 32) * 0.8;
      }
      lastTime = time;
      position(rect);
      frame = requestAnimationFrame(tick);
    }

    function finish() {
      listeners.abort();
      cancelAnimationFrame(frame);
      cancel.current = null;
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      if (marker) delete marker.dataset.drop;
      if (virtual) pin(-1);
      delete row.dataset.lifted;
      delete list.dataset.dragging;
      row.style.removeProperty('translate');
    }

    cancel.current = finish;
    if (virtual) pin(from); // Pointer capture stays attached even far outside the visible window.
    handle.setPointerCapture(pointer);
    handle.addEventListener('pointermove', e => {
      if (e.pointerId !== pointer) return;
      x = e.clientX;
      y = e.clientY;
      if (!dragging && Math.abs(y - startY) >= 4) {
        dragging = true;
        list.dataset.dragging = '';
        row.dataset.lifted = '';
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
      }
    }, options);
    handle.addEventListener('pointerup', e => {
      if (e.pointerId !== pointer) return;
      y = e.clientY;
      const rect = list.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && y >= rect.top && y <= rect.bottom;
      if (dragging && inside) position(rect);
      finish();
      if (dragging && inside && to !== from) move(from, to);
    }, options);
    const abortPointer = (e: PointerEvent) => { if (e.pointerId === pointer) finish(); };
    handle.addEventListener('pointercancel', abortPointer, options);
    handle.addEventListener('lostpointercapture', abortPointer, options);
    window.addEventListener('blur', finish, options);
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish();
    }, { ...options, capture: true });
  };
}
