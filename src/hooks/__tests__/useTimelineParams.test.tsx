import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useTimelineParams } from '../useTimelineParams';

const wrapperAt = (url: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  };

describe('useTimelineParams', () => {
  it('defaults to month zoom with no filters', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline') });
    expect(result.current).toMatchObject({ zoom: 'month', album: '', people: [], to: '' });
  });

  it('reads zoom, filters and to from the URL', () => {
    const { result } = renderHook(() => useTimelineParams(), {
      wrapper: wrapperAt('/timeline?zoom=day&album=Kanha&people=a1,b2&to=2025-02-28'),
    });
    expect(result.current).toMatchObject({ zoom: 'day', album: 'Kanha', people: ['a1', 'b2'], to: '2025-02-28' });
  });

  it('ignores an unknown zoom', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline?zoom=decade') });
    expect(result.current.zoom).toBe('month');
  });

  it('setZoom writes the zoom and omits it for month', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline') });
    act(() => result.current.setZoom('day'));
    expect(result.current.zoom).toBe('day');
    act(() => result.current.setZoom('month'));
    expect(result.current.zoom).toBe('month');
  });

  it('setZoom with a month also sets to the end of that month in one write', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline?album=Kanha') });
    act(() => result.current.setZoom('day', '2024-02'));
    expect(result.current).toMatchObject({ zoom: 'day', to: '2024-02-29', album: 'Kanha' });
    act(() => result.current.setZoom('month', '2023-11'));
    expect(result.current).toMatchObject({ zoom: 'month', to: '2023-11-30' });
  });

  it('setFilters patches album and people', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline?to=2025-02-28') });
    act(() => result.current.setFilters({ album: 'Kanha', people: ['a1'] }));
    expect(result.current).toMatchObject({ album: 'Kanha', people: ['a1'] });
    act(() => result.current.setFilters({ album: '' }));
    expect(result.current.album).toBe('');
  });

  it.each([
    ['2025-02', '2025-02-28'],
    ['2024-02', '2024-02-29'],
    ['2025-03', '2025-03-31'],
    ['2025-04', '2025-04-30'],
    ['2000-02', '2000-02-29'],
    ['1900-02', '1900-02-28'],
    ['2025-3', '2025-03-31'],
  ])('jumpTo(%s) sets to=%s', (month, expected) => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline') });
    act(() => result.current.jumpTo(month));
    expect(result.current.to).toBe(expected);
  });

  it('reads known, deduped and capped so people plus known is at most 5', () => {
    const { result } = renderHook(() => useTimelineParams(), {
      wrapper: wrapperAt('/timeline?people=a,b,c&known=k1,k1,k2,k3'),
    });
    expect(result.current.people).toEqual(['a', 'b', 'c']);
    expect(result.current.known).toEqual(['k1', 'k2']);
  });

  it('setFilters writes known', () => {
    const { result } = renderHook(() => useTimelineParams(), { wrapper: wrapperAt('/timeline') });
    act(() => result.current.setFilters({ people: ['a1'], known: ['ms'] }));
    expect(result.current).toMatchObject({ people: ['a1'], known: ['ms'] });
  });
});
