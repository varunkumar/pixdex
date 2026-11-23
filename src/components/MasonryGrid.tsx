import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { balanceColumns, planWidths } from './masonry';

interface MasonryGridProps<T> {
  items: T[];
  ratioOf: (item: T) => number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  columns: number;
}

/**
 * Masonry that keeps each tile's real aspect ratio. Columns are balanced to similar heights, then, when the page has
 * enough photos and the widths stay moderate, each column's width is set from its height (`planWidths`) so they all
 * end on the same line with no cropping; tiles then grow a hair (in proportion to their height) to absorb the pixel
 * gaps. When that is not possible (a short page, extreme shapes) the grid is NOT stretched: tiles keep their own shape
 * and the bottom edge is simply uneven.
 */
function MasonryGrid<T>({ items, ratioOf, keyOf, renderItem, columns }: MasonryGridProps<T>) {
  const { assignment, plan, ratios } = useMemo(() => {
    const ratios = items.map((item) => ratioOf(item));
    const assignment = balanceColumns(ratios, columns).filter((column) => column.length > 0);
    return { assignment, plan: planWidths(assignment, ratios, columns), ratios };
  }, [items, ratioOf, columns]);
  const sparse = assignment.length < columns;
  const tileTotal = (indexes: number[]) => indexes.reduce((sum, i) => sum + 1 / ratios[i], 0);
  const columnStyle = (c: number): CSSProperties => {
    if (plan.flush) return { flexGrow: plan.widths[c] };
    // A short page keeps fixed, normal-sized columns; a full page with extreme shapes shares the row equally.
    return sparse
      ? { flexGrow: 0, flexShrink: 0, flexBasis: `calc(var(--pdx-col) * ${plan.widths[c]})` }
      : { flexGrow: 1 };
  };
  return (
    <div className="pdx-masonry" data-flush={plan.flush} style={{ '--cols': columns } as CSSProperties}>
      {assignment.map((indexes, c) => (
        <div key={c} className="pdx-masonry-col" data-testid="masonry-column" style={columnStyle(c)}>
          {indexes.map((i) => (
            <div key={keyOf(items[i])} style={{ flexGrow: plan.flush ? 1 / ratios[i] / tileTotal(indexes) : 0 }}>
              {renderItem(items[i])}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default MasonryGrid;
