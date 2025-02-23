import { Box, ChakraProvider, Container } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import Albums from './components/Albums';
import DailySuggestion from './components/DailySuggestion';
import Dashboard from './components/Dashboard';
import Navigation from './components/Navigation';
import Search from './components/Search';
import Settings from './components/Settings';

const queryClient = new QueryClient();

function App() {
  return (
    <ChakraProvider>
      <QueryClientProvider client={queryClient}>
        <Router>
          <Box minH="100vh">
            <Navigation />
            <Box bg="gray.50" minH="calc(100vh - 64px)">
              <Container maxW="container.xl" py={8}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/albums" element={<Albums />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/daily" element={<DailySuggestion />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Container>
            </Box>
          </Box>
        </Router>
      </QueryClientProvider>
    </ChakraProvider>
  );
}

export default App;
