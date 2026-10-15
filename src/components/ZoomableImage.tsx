import { useEffect, useRef, useState } from 'react';

const MAX_SCALE = 8;

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

interface Props {
  src: string;
  alt: string;
  height: string;
}

/**
 * Lightroom-style viewer: shows the whole photo (Fit); click or double-click
 * toggles to 100% on the point under the cursor; wheel or pinch zooms around
 * the cursor; drag pans when zoomed.
 */
const ZoomableImage = ({ src, alt, height }: Props) => {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View>(FIT);

  const clamp = (v: View): View => {
    const b = box.current;
    const i = img.current;
    if (!b || !i || v.scale <= 1) return FIT;
    const maxX = Math.max(0, (i.offsetWidth * v.scale - b.clientWidth) / 2);
    const maxY = Math.max(0, (i.offsetHeight * v.scale - b.clientHeight) / 2);
    return { scale: v.scale, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  };

  // Offsets from the box centre, so a point stays under the cursor while scaling.
  const zoomAt = (clientX: number, clientY: number, scale: number) => {
    const b = box.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const px = clientX - (r.left + r.width / 2);
    const py = clientY - (r.top + r.height / 2);
    setView((v) => {
      const ns = Math.min(MAX_SCALE, Math.max(1, scale));
      const k = ns / v.scale;
      return clamp({ scale: ns, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    });
  };

  const actualSizeScale = () => {
    const i = img.current;
    if (!i || !i.offsetWidth) return 2;
    return Math.min(MAX_SCALE, Math.max(2, i.naturalWidth / i.offsetWidth));
  };

  const toggle = (clientX: number, clientY: number) => {
    if (view.scale > 1) setView(FIT);
    else zoomAt(clientX, clientY, actualSizeScale());
  };

  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      const px = e.clientX - (r.left + r.width / 2);
      const py = e.clientY - (r.top + r.height / 2);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => {
        const ns = Math.min(MAX_SCALE, Math.max(1, v.scale * factor));
        const k = ns / v.scale;
        return clamp({ scale: ns, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
      });
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (view.scale > 1) setView((v) => clamp({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) toggle(e.clientX, e.clientY);
  };

  return (
    <div
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
      }}
      style={{
        width: '100%',
        height,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        userSelect: 'none',
        cursor: view.scale > 1 ? 'grab' : 'zoom-in',
      }}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: 'center',
          willChange: 'transform',
        }}
      />
    </div>
  );
};

export default ZoomableImage;
