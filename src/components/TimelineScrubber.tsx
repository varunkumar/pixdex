import { Box, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Keep the rail clear of the 60px app header and the viewport bottom on short screens.
const RAIL_TOP = 76;
const RAIL_BOTTOM = 16;
// A year label is drawn only when it sits at least this far below the previous
// one, so a crowded rail thins its labels instead of overlapping them.
const MIN_LABEL_GAP = 12;

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
  // The month under the pointer during a drag: shown locally, committed once on release.
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [rowHeight, setRowHeight] = useState(Infinity);

  const count = buckets.length;
  useEffect(() => {
    const measure = () => {
      const h = railRef.current?.getBoundingClientRect().height ?? 0;
      // No layout (height 0) means unknown: keep the labels.
      setRowHeight(h > 0 && count > 0 ? h / count : Infinity);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [count]);

  if (count === 0) return null;

  const monthAt = (clientY: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    const index = Math.floor(((clientY - rect.top) / rect.height) * count);
    return buckets[Math.min(count - 1, Math.max(0, index))].month;
  };

  const track = (clientY: number) => {
    const month = monthAt(clientY);
    if (!month || month === previewRef.current) return;
    previewRef.current = month;
    setPreview(month);
  };

  const reset = () => {
    dragging.current = false;
    previewRef.current = null;
    setPreview(null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    try {
      railRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is only a nicety: moves still arrive while the pointer stays over the rail.
    }
    track(e.clientY);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragging.current) track(e.clientY);
  };

  // One jump per press-drag-release, so a drag is a single feed reload, not one per month crossed.
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging.current) return;
    track(e.clientY);
    const month = previewRef.current;
    reset();
    if (month) onJump(month);
  };

  const shown = preview ?? activeMonth;

  // Rows of year starts that get a label, each at least MIN_LABEL_GAP below the last one drawn.
  const yearLabelRows = new Set<number>();
  let lastLabelRow = -Infinity;
  buckets.forEach(({ month }, i) => {
    const yearStart = i === 0 || buckets[i - 1].month.slice(0, 4) !== month.slice(0, 4);
    if (yearStart && (i - lastLabelRow) * rowHeight >= MIN_LABEL_GAP) {
      yearLabelRows.add(i);
      lastLabelRow = i;
    }
  });
  const previewRow = preview ? buckets.findIndex((b) => b.month === preview) : -1;

  return (
    // The outer box only positions the rail; the inner column is the whole hit area.
    <Box
      visibleFrom="md"
      style={{
        position: 'fixed',
        right: 4,
        top: RAIL_TOP,
        bottom: RAIL_BOTTOM,
        width: 56,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <Box
        ref={railRef}
        data-testid="timeline-scrubber"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onLostPointerCapture={reset}
        style={{
          width: '100%',
          height: `min(100%, ${count * 16}px)`,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          pointerEvents: 'auto',
          touchAction: 'none',
          userSelect: 'none',
          cursor: 'ns-resize',
        }}
      >
        {previewRow >= 0 && (
          // Floats left of the rail at the previewed row, using the same equal-row math as monthAt.
          <Text
            data-testid="scrubber-preview"
            size="sm"
            fw={600}
            px="xs"
            py={2}
            style={{
              position: 'absolute',
              right: '100%',
              top: `${((previewRow + 0.5) / count) * 100}%`,
              transform: 'translateY(-50%)',
              marginRight: 8,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              borderRadius: 4,
              background: 'var(--mantine-color-body)',
              boxShadow: 'var(--mantine-shadow-sm)',
            }}
          >
            {monthLabel(preview as string)}
          </Text>
        )}
        {buckets.map(({ month, total }, i) => {
          const year = month.slice(0, 4);
          const showYear = yearLabelRows.has(i);
          const active = month === shown;
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
                  // A pointer press jumps on release; only keyboard activation (detail 0) lands here.
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
    </Box>
  );
};

export default TimelineScrubber;
