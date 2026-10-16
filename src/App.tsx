import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, ScrollRestoration } from 'react-router-dom';
import AlbumPhotos from './components/AlbumPhotos';
import Albums from './components/Albums';
import DailySuggestion from './components/DailySuggestion';
import Dashboard from './components/Dashboard';
import Layout from './components/Layout';
import People from './components/People';
import PersonPage from './components/PersonPage';
import PhotoDetail from './components/PhotoDetail';
import Search from './components/Search';
import { theme } from './theme';

const queryClient = new QueryClient({
  // One retry, then show the error: three backed-off retries kept spinners going for seconds.
  // Refetching on every tab focus only surfaces errors for data that rarely changes.
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const RootLayout = () => (
  <>
    <Layout />
    <ScrollRestoration />
  </>
);

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/albums', element: <Albums /> },
      { path: '/albums/:name', element: <AlbumPhotos /> },
      { path: '/search', element: <Search /> },
      { path: '/photos/:id', element: <PhotoDetail /> },
      { path: '/people', element: <People /> },
      { path: '/people/:id', element: <PersonPage /> },
      { path: '/daily', element: <DailySuggestion /> },
    ],
  },
]);

function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  );
}

export default App;
