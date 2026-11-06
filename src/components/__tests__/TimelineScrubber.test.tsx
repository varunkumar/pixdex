import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';
import TimelineScrubber from '../TimelineScrubber';

const buckets = [
  { month: '2026-01', total: 40 },
  { month: '2025-03', total: 5 },
  { month: '2025-01', total: 1 },
  { month: '2024-12', total: 12 },
];

const setup = (props: Partial<Parameters<typeof TimelineScrubber>[0]> = {}) => {
  const onJump = vi.fn();
  const utils = render(
    <MantineProvider>
      <TimelineScrubber buckets={buckets} activeMonth={null} onJump={onJump} {...props} />
    </MantineProvider>
  );
  return { onJump, ...utils };
};

// jsdom has no layout: give the rail a 400px box so four rows are 100px each.
const sizeRail = () => {
  const rail = screen.getByTestId('timeline-scrubber');
  rail.getBoundingClientRect = () =>
    ({ top: 0, height: 400, bottom: 400, left: 0, right: 20, width: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return rail;
};

describe('TimelineScrubber', () => {
  it('renders a year label and a tick per month present only', () => {
    setup();
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.getByText('2024')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'March 2025' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'February 2025' })).not.toBeInTheDocument();
  });

  it('marks the active month with aria-current', () => {
    setup({ activeMonth: '2025-03' });
    expect(screen.getByRole('button', { name: 'March 2025' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'January 2026' })).not.toHaveAttribute('aria-current');
  });

  it('jumps to a month when its tick is activated', () => {
    const { onJump } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'March 2025' }));
    expect(onJump).toHaveBeenCalledWith('2025-03');
  });

  it('previews while dragging and commits a single jump on release', () => {
    const { onJump } = setup();
    const rail = sizeRail();
    fireEvent.pointerDown(rail, { clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(rail, { clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(rail, { clientY: 130, pointerId: 1 });
    expect(screen.getByRole('button', { name: 'March 2025' })).toHaveAttribute('aria-current', 'true');
    fireEvent.pointerMove(rail, { clientY: 390, pointerId: 1 });
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.pointerUp(rail, { clientY: 390, pointerId: 1 });
    fireEvent.pointerMove(rail, { clientY: 10, pointerId: 1 });
    expect(onJump.mock.calls).toEqual([['2024-12']]);
  });

  it('jumps on a pointer press and release on a tick, without a double jump from the click', () => {
    const { onJump } = setup();
    sizeRail();
    const tick = screen.getByRole('button', { name: 'March 2025' });
    fireEvent.pointerDown(tick, { clientY: 150, pointerId: 1, button: 0 });
    fireEvent.pointerUp(tick, { clientY: 150, pointerId: 1 });
    fireEvent.click(tick, { detail: 1 });
    expect(onJump.mock.calls).toEqual([['2025-03']]);
  });

  it('ignores non-primary buttons and a cancelled drag', () => {
    const { onJump } = setup();
    const rail = sizeRail();
    fireEvent.pointerDown(rail, { clientY: 10, pointerId: 1, button: 2 });
    fireEvent.pointerUp(rail, { clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(rail, { clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerCancel(rail, { pointerId: 1 });
    fireEvent.pointerUp(rail, { clientY: 10, pointerId: 1 });
    expect(onJump).not.toHaveBeenCalled();
  });

  it('shows a floating label with the previewed month while dragging, gone on release', () => {
    setup();
    const rail = sizeRail();
    expect(screen.queryByTestId('scrubber-preview')).not.toBeInTheDocument();
    fireEvent.pointerDown(rail, { clientY: 10, pointerId: 1, button: 0 });
    expect(screen.getByTestId('scrubber-preview')).toHaveTextContent('January 2026');
    fireEvent.pointerMove(rail, { clientY: 130, pointerId: 1 });
    const label = screen.getByTestId('scrubber-preview');
    expect(label).toHaveTextContent('March 2025');
    // Second of four equal rows: centred at 37.5% of the rail.
    expect(label.style.top).toBe('37.5%');
    expect(label.style.pointerEvents).toBe('none');
    fireEvent.pointerUp(rail, { clientY: 130, pointerId: 1 });
    expect(screen.queryByTestId('scrubber-preview')).not.toBeInTheDocument();
  });

  // Re-measures the rail at the given height, as a window resize would.
  const measureRail = (height: number) => {
    const rail = screen.getByTestId('timeline-scrubber');
    rail.getBoundingClientRect = () => ({ top: 0, height, bottom: height }) as DOMRect;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };

  it('thins year labels on a crowded rail so none overlap', () => {
    // 40 years with 3 months each: 120 rows of 2.5px, so year starts are 7.5px apart.
    const many: { month: string; total: number }[] = [];
    for (let y = 2025; y > 1985; y--)
      for (const m of ['11', '06', '01']) many.push({ month: `${y}-${m}`, total: 3 });
    setup({ buckets: many });
    measureRail(300);
    const rowHeight = 300 / many.length;
    const labels = screen.getAllByText(/^\d{4}$/);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.length).toBeLessThan(40);
    // Each label sits in the row of its year's first (newest) month, the tick beside it.
    const rows = labels.map((l) => {
      const tick = l.parentElement?.querySelector('button')?.getAttribute('aria-label');
      expect(tick).toBe(`November ${l.textContent}`);
      return many.findIndex((b) => b.month === `${l.textContent}-11`);
    });
    expect(rows[0]).toBe(0);
    for (let i = 1; i < rows.length; i++) expect((rows[i] - rows[i - 1]) * rowHeight).toBeGreaterThanOrEqual(12);
  });

  it('keeps every year label when the rows are tall enough', () => {
    setup();
    measureRail(400);
    expect(screen.getAllByText(/^\d{4}$/).map((l) => l.textContent)).toEqual(['2026', '2025', '2024']);
  });

  it('renders nothing for an empty bucket list', () => {
    setup({ buckets: [] });
    expect(screen.queryByTestId('timeline-scrubber')).not.toBeInTheDocument();
  });
});
