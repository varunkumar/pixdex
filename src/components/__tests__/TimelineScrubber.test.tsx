import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders nothing for an empty bucket list', () => {
    setup({ buckets: [] });
    expect(screen.queryByTestId('timeline-scrubber')).not.toBeInTheDocument();
  });
});
