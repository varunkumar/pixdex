// The edit mode of the album banner: a surface over the picture (drag, pinch, keys) and the controls below it.
import { Button, Group, Slider, Text } from '@mantine/core';
import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import {
  clampFraming,
  DEFAULT_FRAMING,
  dragFraming,
  MAX_ZOOM,
  MIN_ZOOM,
  type Framing,
  type Size,
} from '../services/framing';

const KEY_STEP = 1;
const KEY_STEP_SHIFT = 10;
const KEY_ZOOM_STEP = 0.1;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Point = { x: number; y: number };

const middle = ([a, b = a]: Point[]): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const spread = ([a, b = a]: Point[]) => Math.hypot(b.x - a.x, b.y - a.y);

interface SurfaceProps {
  framing: Framing;
  /** The picture's own size, which decides how far it can move. */
  natural: Size;
  disabled: boolean;
  onChange: (framing: Framing) => void;
}

export function FramingSurface({ framing, natural, disabled, onChange }: SurfaceProps) {
  // The fingers (or the mouse) on the surface, and where they and the framing were when that set last changed.
  // Moves are measured from there, so adding or lifting a finger never makes the picture jump.
  const gesture = useRef({
    pointers: new Map<number, Point>(),
    from: [] as Point[],
    base: framing,
    latest: framing,
  });
  const rebase = () => {
    const g = gesture.current;
    g.from = [...g.pointers.values()].slice(0, 2);
    g.base = g.latest;
  };
  // Focused on arrival, so the keys work at once.
  const focus = useCallback((element: HTMLDivElement | null) => element?.focus({ preventScroll: true }), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const g = gesture.current;
    if (g.pointers.size === 0) g.latest = framing;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rebase();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (disabled || !g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = [...g.pointers.values()].slice(0, 2);
    const was = spread(g.from);
    // Two pointers: their distance zooms, their midpoint moves.
    const zoomed = clampFraming({ ...g.base, zoom: g.base.zoom * (was > 0 ? spread(now) / was : 1) });
    const start = middle(g.from);
    const end = middle(now);
    const { width, height } = e.currentTarget.getBoundingClientRect();
    g.latest = dragFraming(zoomed, end.x - start.x, end.y - start.y, natural, { w: width, h: height });
    onChange(g.latest);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (gesture.current.pointers.delete(e.pointerId)) rebase();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const arrow = ARROWS[e.key];
    const zoom = e.key === '+' ? KEY_ZOOM_STEP : e.key === '-' ? -KEY_ZOOM_STEP : 0;
    if (!arrow && !zoom) return;
    e.preventDefault();
    if (disabled) return;
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    const [dx, dy] = arrow ?? [0, 0];
    onChange(clampFraming({ x: framing.x + dx * step, y: framing.y + dy * step, zoom: framing.zoom + zoom }));
  };

  return (
    <div
      ref={focus}
      className="pdx-hero-surface"
      role="application"
      aria-label="Reposition cover photo: drag or use the arrow keys to move, plus and minus to zoom"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
    />
  );
}

interface ToolbarProps {
  framing: Framing;
  saving: boolean;
  error: Error | null;
  onChange: (framing: Framing) => void;
  onSave: () => void;
  onCancel: () => void;
}

const zoomText = (zoom: number) => `${zoom.toFixed(2)}x`;

export function FramingToolbar({ framing, saving, error, onChange, onSave, onCancel }: ToolbarProps) {
  return (
    <>
      <Group gap="md" mt="sm">
        <Group gap="sm" wrap="nowrap" className="pdx-hero-zoom">
          <Text size="sm" aria-hidden>
            Zoom
          </Text>
          <Slider
            flex={1}
            thumbLabel="Zoom"
            thumbSize={22}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.05}
            label={zoomText}
            thumbValueText={zoomText}
            disabled={saving}
            value={framing.zoom}
            onChange={(zoom) => onChange(clampFraming({ ...framing, zoom }))}
          />
        </Group>
        <Group gap="xs" ml="auto">
          <Button size="sm" variant="subtle" disabled={saving} onClick={() => onChange(DEFAULT_FRAMING)}>
            Reset
          </Button>
          <Button size="sm" variant="default" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" loading={saving} onClick={onSave}>
            Save
          </Button>
        </Group>
      </Group>
      {error && (
        <Text c="red" size="sm" mt="xs" role="alert">
          {error.message}
        </Text>
      )}
    </>
  );
}
