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
    // Five equal tiles in 3 columns: heights 2, 2, 1 (plus gaps), so the short column gets about twice the width.
    const rendered = render(
      <MasonryGrid
        items={items(5)}
        ratioOf={() => 1}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={3}
      />
    );
    const grows = within(rendered.container)
      .getAllByTestId('masonry-column')
      .map((c) => Number.parseFloat((c as HTMLElement).style.flexGrow));
    expect(grows[0]).toBeCloseTo(grows[1]);
    expect(grows[2]).toBeGreaterThan(grows[0]);
    expect(grows[2] / grows[0]).toBeGreaterThan(1.8);
    expect(grows[2] / grows[0]).toBeLessThan(2.1);
  });

  it('fills the full width on a phone-sized grid of tall columns: the grow values add up to the column count', () => {
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
    expect(sum(cols.map((c) => Number.parseFloat(c.style.flexGrow)))).toBeCloseTo(2);
    for (const col of cols) {
      const tiles = [...col.children] as HTMLElement[];
      expect(sum(tiles.map((t) => Number.parseFloat(t.style.flexGrow)))).toBeCloseTo(1);
    }
    expect(rendered.container.firstElementChild).toHaveAttribute('data-flush', 'true');
  });

  it('does not stretch a tile when the grid cannot end flush: a sparse page keeps every tile at its own shape', () => {
    const rendered = render(
      <MasonryGrid
        items={[
          { id: 'portrait', r: 0.667 },
          { id: 'landscape', r: 1.5 },
        ]}
        ratioOf={(i) => i.r}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={4}
      />
    );
    expect(rendered.container.firstElementChild).toHaveAttribute('data-flush', 'false');
    const cols = within(rendered.container).getAllByTestId('masonry-column') as HTMLElement[];
    expect(cols).toHaveLength(2);
    for (const col of cols) {
      expect(col.style.flexGrow).toBe('0'); // a fixed width, not stretched to fill the row
      for (const tile of [...col.children] as HTMLElement[]) expect(tile.style.flexGrow).toBe('0');
    }
  });

  it('falls back to equal columns, still unstretched, when flush would need extreme widths', () => {
    const rendered = render(
      <MasonryGrid
        items={[
          { id: 'tall', r: 0.4 },
          { id: 'wide', r: 3 },
        ]}
        ratioOf={(i) => i.r}
        keyOf={(i) => i.id}
        renderItem={(i) => <span>{i.id}</span>}
        columns={2}
      />
    );
    expect(rendered.container.firstElementChild).toHaveAttribute('data-flush', 'false');
    const cols = within(rendered.container).getAllByTestId('masonry-column') as HTMLElement[];
    expect(cols.map((c) => Number.parseFloat(c.style.flexGrow))).toEqual([1, 1]);
    for (const col of cols) for (const tile of [...col.children] as HTMLElement[]) expect(tile.style.flexGrow).toBe('0');
  });

  it('gives a lone tile in a flush column the whole column height to grow into', () => {
    const rendered = render(
      <MasonryGrid
        items={items(3)}
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
