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

  it('renders no empty columns when there are fewer items than columns', () => {
    renderGrid(2, 3);
    expect(screen.getAllByTestId('masonry-column')).toHaveLength(2);
  });

  it('sizes columns by their height so a short column is wider and all of them end flush', () => {
    // Four equal tiles in 3 columns: heights 2, 1, 1 (plus a gap), so the first column gets about half the width.
    const rendered = render(
      <MasonryGrid
        items={items(4)}
        ratioOf={() => 1}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={3}
      />
    );
    const grows = within(rendered.container)
      .getAllByTestId('masonry-column')
      .map((c) => Number.parseFloat((c as HTMLElement).style.flexGrow));
    expect(grows[0]).toBeLessThan(grows[1]);
    expect(grows[1]).toBeCloseTo(grows[2]);
    expect(grows[1] / grows[0]).toBeGreaterThan(1.8);
    expect(grows[1] / grows[0]).toBeLessThan(2.1);
  });

  it('normalises the flex-grow weights to sum to 1, so a grid of tall columns still fills the full width', () => {
    // CSS only hands out the share of free space equal to the sum of the grow values when that sum is below 1.
    const rendered = render(
      <MasonryGrid
        items={items(6)}
        ratioOf={() => 0.5}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={2}
      />
    );
    const cols = within(rendered.container).getAllByTestId('masonry-column') as HTMLElement[];
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    expect(sum(cols.map((c) => Number.parseFloat(c.style.flexGrow)))).toBeCloseTo(1);
    for (const col of cols) {
      const tiles = [...col.children] as HTMLElement[];
      expect(sum(tiles.map((t) => Number.parseFloat(t.style.flexGrow)))).toBeCloseTo(1);
    }
  });

  it('gives a lone tile in a column the whole column height to grow into', () => {
    const rendered = render(
      <MasonryGrid
        items={items(1)}
        ratioOf={() => 1.5}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={3}
      />
    );
    const tile = within(rendered.container).getAllByTestId('masonry-column')[0].firstElementChild as HTMLElement;
    expect(Number.parseFloat(tile.style.flexGrow)).toBeCloseTo(1);
  });
});
