import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const visited = new WeakMap<QueryClient, Map<string, string>>();

/** Pages that in-page "back" links lead to call this, so the links can return to the same page number and sort. */
export function useRememberAddress() {
  const client = useQueryClient();
  const { pathname, search } = useLocation();
  useEffect(() => {
    const pages = visited.get(client) ?? new Map<string, string>();
    visited.set(client, pages.set(pathname, `${pathname}${search}`));
  }, [client, pathname, search]);
}

/** The address `pathname` was last shown at, or the plain path. Browser memory only. */
export function useLastAddress(pathname: string): string {
  return visited.get(useQueryClient())?.get(pathname) ?? pathname;
}
