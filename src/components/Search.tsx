import {
  Box,
  Button,
  Card,
  CardBody,
  Input as ChakraInput,
  FormControl,
  FormLabel,
  Grid,
  Image,
  Select,
  SimpleGrid,
  Stack,
  Tag,
  Text,
  useToast,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../services/api/ApiClient';
import { SearchCriteria } from '../types/photo';

const Search = () => {
  const [criteria, setCriteria] = useState<SearchCriteria>({
    query: '',
    album: '',
  });
  const toast = useToast();

  const {
    data: results = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', criteria],
    queryFn: () => apiClient.searchPhotos(criteria),
    enabled: false,
  });

  // Add query for albums
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => apiClient.getAlbums(),
  });

  const handleSearch = () => {
    refetch().catch((err) => {
      toast({
        title: 'Search failed',
        description: err.message,
        status: 'error',
        duration: 3000,
      });
    });
  };

  return (
    <Box w="100%">
      <Card mb={8}>
        <CardBody>
          <Stack spacing={4}>
            <Grid
              templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }}
              gap={4}
            >
              <FormControl id="album-select">
                <FormLabel>Album</FormLabel>
                <Select
                  aria-label="Select photo album"
                  name="album"
                  placeholder="Select Album"
                  value={criteria.album || ''}
                  onChange={(e) =>
                    setCriteria({ ...criteria, album: e.target.value })
                  }
                >
                  {albums.map((album) => (
                    <option key={album} value={album}>
                      {album}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Search</FormLabel>
                <ChakraInput
                  placeholder="Search photos..."
                  value={criteria.query || ''}
                  onChange={(e) =>
                    setCriteria({ ...criteria, query: e.target.value })
                  }
                />
              </FormControl>
              <Box pt={{ base: 0, md: 8 }}>
                <Button
                  w="100%"
                  colorScheme="teal"
                  onClick={handleSearch}
                  isLoading={isLoading}
                >
                  Search
                </Button>
              </Box>
            </Grid>
          </Stack>
        </CardBody>
      </Card>

      {error && (
        <Text color="red.500">
          {error instanceof Error ? error.message : 'An error occurred'}
        </Text>
      )}

      <SimpleGrid columns={[1, 2, 3]} spacing={4}>
        {results.map((photo) => (
          <Box
            key={photo.id}
            borderWidth={1}
            borderRadius="lg"
            overflow="hidden"
          >
            <Image
              src={
                photo.path.startsWith('gdrive://')
                  ? `http://localhost:3001/api/photos/${photo.id}/content`
                  : photo.path
              }
              alt={photo.aiMetadata.description}
              objectFit="cover"
              height="200px"
              width="100%"
            />
            <Box p={4}>
              <Text fontSize="sm" mb={2}>
                {photo.aiMetadata.description}
              </Text>
              <Stack direction="row" flexWrap="wrap" gap={2}>
                {photo.aiMetadata.tags.map((tag) => (
                  <Tag key={tag} size="sm">
                    {tag}
                  </Tag>
                ))}
              </Stack>
            </Box>
          </Box>
        ))}
      </SimpleGrid>
    </Box>
  );
};

export default Search;
