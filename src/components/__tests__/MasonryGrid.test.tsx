import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MasonryGrid from '../MasonryGrid';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, r: 1 }));

const renderGrid = (n: number, columns: number) =>
  render(
    <MasonryGrid
      items={items(n)}
      ratioOf={(i) => i.r}
      keyOf={(i) => i.id}
      renderItem={(i) => <span>{i.id}</span>}
      columns={columns}
    />
  );

describe('MasonryGrid', () => {
  it('renders the requested number of columns holding every item once', () => {
    renderGrid(5, 2);
    const cols = screen.getAllByTestId('masonry-column');
    expect(cols).toHaveLength(2);
    const texts = cols.flatMap((c) => within(c).queryAllByText(/^k\d$/).map((e) => e.textContent));
    expect(texts.sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  });

  it('renders empty columns when there are fewer items than columns', () => {
    renderGrid(2, 3);
    expect(screen.getAllByTestId('masonry-column')).toHaveLength(3);
  });
});
