import { useMemo, type ReactNode } from 'react';
import { assignColumns } from './masonry';

interface MasonryGridProps<T> {
  items: T[];
  ratioOf: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  columns: number;
}

/** Shortest-column masonry: keeps near row-major order and reserves each tile's real aspect ratio. */
function MasonryGrid<T>({ items, ratioOf, keyOf, renderItem, columns }: MasonryGridProps<T>) {
  const assignment = useMemo(
    () =>
      assignColumns(
        items.map((item) => ratioOf(item)),
        columns
      ),
    // ratioOf is derived from the items; recompute only when they or the column count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, columns]
  );
  return (
    <div className="pdx-masonry">
      {assignment.map((indexes, c) => (
        <div key={c} className="pdx-masonry-col" data-testid="masonry-column">
          {indexes.map((i) => (
            <div key={keyOf(items[i])}>{renderItem(items[i])}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default MasonryGrid;
