/* eslint-disable react-refresh/only-export-components -- test helper, never hot-reloaded */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  type RouteObject,
} from 'react-router-dom';
import { theme } from '../theme';

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} env="test">
        <Notifications />
        {children}
      </MantineProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(ui: ReactElement, opts: { route?: string; path?: string } = {}) {
  const { route = '/', path } = opts;
  const tree = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  );
  return render(
    <Providers>
      <MemoryRouter initialEntries={[route]}>{tree}</MemoryRouter>
    </Providers>
  );
}

/** For tests that need real history (back/forward) or location state. */
export function renderWithRouter(routes: RouteObject[], initialEntries: string[]) {
  const router = createMemoryRouter(routes, { initialEntries });
  const utils = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
  return { router, ...utils };
}
