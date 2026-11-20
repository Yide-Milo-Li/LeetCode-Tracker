import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useState, type CSSProperties, type FocusEvent, type ReactNode, type RefObject } from 'react';

type RowProps = {
  'data-index': number;
  'aria-posinset'?: number;
  'aria-setsize'?: number;
  ref?: (element: HTMLLIElement | null) => void;
  style?: CSSProperties;
};

/** Leave short lists in normal flow. Long lists retain their full scroll range and measure wrapped rows. */
export function useProblemListWindow<T>(
  items: readonly T[], keyOf: (item: T) => string, container: RefObject<HTMLElement | null>,
  estimatedHeight: number, pinnedIndex = -1,
) {
  const windowed = items.length > 100;
  const [focused, setFocused] = useState(-1);
  const getItemKey = useCallback((index: number) => keyOf(items[index]), [items, keyOf]);
  const rangeExtractor = useCallback((range: Range) => {
    const indices = defaultRangeExtractor(range);
    for (const index of [focused, pinnedIndex]) {
      if (index >= 0 && index < range.count && !indices.includes(index)) indices.push(index);
    }
    return indices.sort((a, b) => a - b);
  }, [focused, pinnedIndex]);
  const virtual = useVirtualizer<HTMLElement, HTMLLIElement>({
    count: items.length, getItemKey, enabled: windowed, getScrollElement: () => container.current,
    estimateSize: () => estimatedHeight, overscan: 6, rangeExtractor,
  });
  function renderRows(render: (item: T, index: number, props: RowProps) => ReactNode) {
    if (!windowed) return items.map((item, index) => render(item, index, { 'data-index': index }));
    return virtual.getVirtualItems().map(({ index, start }) => render(items[index], index, {
      'data-index': index, 'aria-posinset': index + 1, 'aria-setsize': items.length,
      ref: virtual.measureElement, style: { top: start },
    }));
  }
  return {
    virtual: windowed ? virtual : undefined,
    renderRows,
    listProps: windowed ? {
      'data-windowed': '',
      tabIndex: 0,
      style: { '--list-extent': `${virtual.getTotalSize()}px` } as CSSProperties,
      onFocusCapture: (event: FocusEvent<HTMLElement>) => {
        const row = event.target.closest<HTMLElement>('[data-index]');
        setFocused(row ? Number(row.dataset.index) : -1);
      },
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(-1);
      },
    } : {},
  };
}
