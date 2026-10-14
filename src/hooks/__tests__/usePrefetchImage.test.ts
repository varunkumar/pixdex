import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefetchImage } from '../usePrefetchImage';

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

describe('usePrefetchImage', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is idle and loads nothing without a URL', () => {
    const { result } = renderHook(() => usePrefetchImage(null));
    expect(result.current).toBe('idle');
    expect(FakeImage.instances).toHaveLength(0);
  });

  it('goes loading then ready', () => {
    const { result } = renderHook(() => usePrefetchImage('/api/originals/p1'));
    expect(result.current).toBe('loading');
    expect(FakeImage.instances[0].src).toBe('/api/originals/p1');
    act(() => FakeImage.instances[0].onload?.());
    expect(result.current).toBe('ready');
  });

  it('reports error when the original cannot load', () => {
    const { result } = renderHook(() => usePrefetchImage('/api/originals/p1'));
    act(() => FakeImage.instances[0].onerror?.());
    expect(result.current).toBe('error');
  });
});
