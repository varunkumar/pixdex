import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Grid,
  Heading,
  Link,
  Progress,
  SimpleGrid,
  Stat,
  StatLabel,
  StatNumber,
  Text,
  VStack,
  useToast,
} from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { apiClient } from '../services/api/ApiClient';

interface IndexingProgress {
  current: number;
  total: number;
  stats: {
    New: number;
    Skipped: number;
    Failed: number;
  };
}

const Dashboard = () => {
  const toast = useToast();
  const [indexingProgress, setIndexingProgress] =
    useState<IndexingProgress | null>(null);

  // Separate query for stats that's always enabled
  const {
    data: stats = {
      totalPhotos: 0,
      uniqueSubjects: 0,
      uniqueLocations: 0,
      uniqueAlbums: 0,
    },
    refetch: refetchStats,
  } = useQuery({
    queryKey: ['photoStats'],
    queryFn: () => apiClient.getPhotoStats(),
  });

  const indexMutation = useMutation({
    mutationFn: async () => {
      // Reset progress when starting
      setIndexingProgress(null);

      // Setup event source for progress updates
      const eventSource = new EventSource(
        'http://localhost:3001/api/index/progress'
      );

      eventSource.onmessage = (event) => {
        const progress = JSON.parse(event.data);
        setIndexingProgress(progress);
      };

      eventSource.onerror = () => {
        eventSource.close();
      };

      // Start indexing
      await apiClient.indexLocalPhotos();
      await apiClient.indexGoogleDrivePhotos().catch(() => {});

      // Close event source
      eventSource.close();
      setIndexingProgress(null);

      // Refetch stats after indexing
      refetchStats();
    },
    onSuccess: () => {
      toast({
        title: 'Indexing completed',
        status: 'success',
        duration: 3000,
      });
    },
    onError: (error) => {
      toast({
        title: 'Indexing failed',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        status: 'error',
        duration: 3000,
      });
    },
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Grid
        templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
        gap={6}
        width="100%"
      >
        <Card>
          <CardHeader>
            <Heading size="md">Photo Collection Stats</Heading>
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={2} spacing={4}>
              <Stat>
                <StatLabel>Total Photos</StatLabel>
                <StatNumber>{stats.totalPhotos}</StatNumber>
              </Stat>
              <Stat>
                <StatLabel>Unique Subjects</StatLabel>
                <StatNumber>{stats.uniqueSubjects}</StatNumber>
              </Stat>
              <Stat>
                <StatLabel>Locations</StatLabel>
                <StatNumber>{stats.uniqueLocations}</StatNumber>
              </Stat>
              <Link
                as={RouterLink}
                to="/albums"
                textDecoration="none"
                _hover={{ textDecoration: 'none' }}
              >
                <Stat cursor="pointer">
                  <StatLabel>Albums</StatLabel>
                  <StatNumber>{stats.uniqueAlbums}</StatNumber>
                </Stat>
              </Link>
            </SimpleGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <Heading size="md">Actions</Heading>
          </CardHeader>
          <CardBody>
            <VStack spacing={4} align="stretch">
              <Button
                colorScheme="teal"
                onClick={() => indexMutation.mutate()}
                isLoading={indexMutation.isPending}
              >
                Index Photos
              </Button>
              {indexingProgress && (
                <VStack align="stretch" spacing={2}>
                  <Progress
                    value={
                      (indexingProgress.current / indexingProgress.total) * 100
                    }
                    size="sm"
                    colorScheme="teal"
                    hasStripe
                    isAnimated
                  />
                  <Text fontSize="sm" color="gray.600">
                    {`${indexingProgress.current}/${indexingProgress.total} photos | New: ${indexingProgress.stats.New} | Skipped: ${indexingProgress.stats.Skipped} | Failed: ${indexingProgress.stats.Failed}`}
                  </Text>
                </VStack>
              )}
              <Text fontSize="sm" color="gray.600">
                Start indexing photos from configured local directories and
                Google Drive. This process may take some time depending on the
                number of photos.
              </Text>
            </VStack>
          </CardBody>
        </Card>
      </Grid>
    </VStack>
  );
};

export default Dashboard;
