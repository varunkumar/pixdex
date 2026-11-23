import { useMemo, type ReactNode } from 'react';
import { balanceColumns, columnGrow } from './masonry';

interface MasonryGridProps<T> {
  items: T[];
  ratioOf: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  columns: number;
}

/**
 * Masonry that keeps each tile's real aspect ratio and ends flush at the bottom: columns are balanced to similar
 * heights, then each column's width is set from its height (`columnGrow`) so they all end at the same line, with no
 * cropping. Tiles also grow a hair in proportion to their own height to absorb the pixel gaps between them.
 */
function MasonryGrid<T>({ items, ratioOf, keyOf, renderItem, columns }: MasonryGridProps<T>) {
  const { assignment, grow, ratios } = useMemo(() => {
    const ratios = items.map((item) => ratioOf(item));
    const assignment = balanceColumns(ratios, columns).filter((column) => column.length > 0);
    // Flex-grow values below 1 in total hand out only that share of the free space, so scale each set to sum to 1.
    const raw = columnGrow(assignment, ratios);
    const total = raw.reduce((sum, g) => sum + g, 0) || 1;
    return { assignment, grow: raw.map((g) => g / total), ratios };
  }, [items, ratioOf, columns]);
  const tileTotal = (indexes: number[]) => indexes.reduce((sum, i) => sum + 1 / ratios[i], 0);
  return (
    // --cols keeps a lone column (a sparse group) from stretching wider than 1.5 normal columns.
    <div className="pdx-masonry" style={{ '--cols': columns } as React.CSSProperties}>
      {assignment.map((indexes, c) => (
        <div key={c} className="pdx-masonry-col" data-testid="masonry-column" style={{ flexGrow: grow[c] }}>
          {indexes.map((i) => (
            <div key={keyOf(items[i])} style={{ flexGrow: 1 / ratios[i] / tileTotal(indexes) }}>
              {renderItem(items[i])}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default MasonryGrid;
