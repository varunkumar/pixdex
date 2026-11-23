import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useListParams } from '../useListParams';

const wrapperAt = (url: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  };

describe('useListParams', () => {
  it('defaults to page 1, size 12', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search') });
    expect(result.current).toMatchObject({ page: 1, size: 12, offset: 0 });
  });

  it('rounds the page size up to whole rows for the given column count, keeping the chosen option', () => {
    const { result } = renderHook(() => useListParams(12, undefined, 5), { wrapper: wrapperAt('/albums?page=3') });
    expect(result.current).toMatchObject({ page: 3, size: 15, option: 12, offset: 30 });
  });

  it('keeps a size that already fills the rows', () => {
    const { result } = renderHook(() => useListParams(12, undefined, 4), { wrapper: wrapperAt('/albums?size=24') });
    expect(result.current).toMatchObject({ size: 24, option: 24 });
  });

  it('reads page and size and computes the offset', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?page=3&size=24') });
    expect(result.current).toMatchObject({ page: 3, size: 24, offset: 48 });
  });

  it.each(['page=0', 'page=-2', 'page=abc', 'page='])('treats %s as page 1', (qs) => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt(`/search?${qs}`) });
    expect(result.current.page).toBe(1);
  });

  it('falls back to the default size for sizes that are not offered', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?size=7') });
    expect(result.current.size).toBe(12);
  });

  it('update() patches params, drops empties and defaults, and resets the page', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?q=lion&page=4') });
    act(() => result.current.update({ q: 'leopard', album: '' }, { resetPage: true }));
    expect(result.current.params.get('q')).toBe('leopard');
    expect(result.current.params.has('album')).toBe(false);
    expect(result.current.params.has('page')).toBe(false);
  });

  it('omits size when it equals the default', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?size=24') });
    act(() => result.current.update({ size: 12 }));
    expect(result.current.params.has('size')).toBe(false);
  });

  it('keeps the navigation state (e.g. the albums list to return to) across an update', () => {
    const { result } = renderHook(() => ({ list: useListParams(), location: useLocation() }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[{ pathname: '/albums/x', state: { albumsList: '/albums?page=3' } }]}>
          {children}
        </MemoryRouter>
      ),
    });
    act(() => result.current.list.update({ tab: 'people' }));
    expect(result.current.location.state).toEqual({ albumsList: '/albums?page=3' });
  });
});
