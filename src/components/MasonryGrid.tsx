import { useMemo, type ReactNode } from 'react';
import { balanceColumns, stretchColumns } from './masonry';

interface MasonryGridProps<T> {
  items: T[];
  ratioOf: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  columns: number;
}

/**
 * Masonry that keeps each tile's real aspect ratio and ends flush: columns are balanced to similar heights, and a
 * column that is still a little short lets its tiles grow slightly (cropping the photos) to reach the tallest one.
 */
function MasonryGrid<T>({ items, ratioOf, keyOf, renderItem, columns }: MasonryGridProps<T>) {
  const { assignment, stretch, ratios } = useMemo(() => {
    const ratios = items.map((item) => ratioOf(item));
    const assignment = balanceColumns(ratios, columns);
    return { assignment, stretch: stretchColumns(assignment, ratios), ratios };
    // ratioOf is derived from the items; recompute only when they or the column count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, columns]);
  return (
    <div className="pdx-masonry">
      {assignment.map((indexes, c) => (
        <div key={c} className="pdx-masonry-col" data-testid="masonry-column" data-stretch={stretch[c]}>
          {indexes.map((i) => (
            // Growing in proportion to its own height keeps the crop even across the column.
            <div key={keyOf(items[i])} style={stretch[c] ? { flexGrow: 1 / ratios[i] } : undefined}>
              {renderItem(items[i])}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default MasonryGrid;
