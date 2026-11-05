import { Box, Text, UnstyledButton } from '@mantine/core';
import { useRef, type PointerEvent } from 'react';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Props {
  /** Months that have photos, newest first. */
  buckets: { month: string; total: number }[];
  activeMonth: string | null;
  onJump(month: string): void;
}

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

// Tick width grows with the log of the count so a huge month does not dwarf the rest.
const tickWidth = (total: number) => Math.min(18, 6 + Math.round(Math.log10(Math.max(total, 1)) * 4));

/**
 * Right-edge rail of month ticks. Every tick sits in an equal-height row, so the
 * pointer position maps straight to a row index while dragging.
 */
const TimelineScrubber = ({ buckets, activeMonth, onJump }: Props) => {
  const railRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastMonth = useRef<string | null>(null);

  if (buckets.length === 0) return null;

  const monthAt = (clientY: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    const index = Math.floor(((clientY - rect.top) / rect.height) * buckets.length);
    return buckets[Math.min(buckets.length - 1, Math.max(0, index))].month;
  };

  const jumpAt = (clientY: number) => {
    const month = monthAt(clientY);
    if (!month || month === lastMonth.current) return;
    lastMonth.current = month;
    onJump(month);
  };

  const onPointerDown = (e: PointerEvent) => {
    dragging.current = true;
    lastMonth.current = null;
    try {
      railRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is only a nicety: moves still arrive while the pointer stays over the rail.
    }
    jumpAt(e.clientY);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragging.current) jumpAt(e.clientY);
  };

  const onPointerEnd = () => {
    dragging.current = false;
  };

  return (
    <Box
      ref={railRef}
      data-testid="timeline-scrubber"
      visibleFrom="md"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      style={{
        position: 'fixed',
        right: 4,
        top: '50%',
        transform: 'translateY(-50%)',
        height: `min(80vh, ${buckets.length * 16}px)`,
        width: 56,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'ns-resize',
      }}
    >
      {buckets.map(({ month, total }, i) => {
        const year = month.slice(0, 4);
        const showYear = i === 0 || buckets[i - 1].month.slice(0, 4) !== year;
        const active = month === activeMonth;
        return (
          <Box key={month} style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            {showYear && (
              <Text size="xs" c="dimmed" lh={1} style={{ pointerEvents: 'none' }}>
                {year}
              </Text>
            )}
            <UnstyledButton
              aria-label={monthLabel(month)}
              aria-current={active ? 'true' : undefined}
              title={`${monthLabel(month)} (${total})`}
              onClick={(e) => {
                // A pointer press already jumped on pointerdown; only keyboard activation lands here.
                if (e.detail === 0) onJump(month);
              }}
              style={{
                width: tickWidth(total),
                height: 3,
                borderRadius: 2,
                flexShrink: 0,
                background: active ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-dimmed)',
                opacity: active ? 1 : 0.6,
              }}
            />
          </Box>
        );
      })}
    </Box>
  );
};

export default TimelineScrubber;
