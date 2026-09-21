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
import { workerApiClient } from '../services/api/WorkerApiClient';

const Search = () => {
  const [query, setQuery] = useState('');
  const [album, setAlbum] = useState('');
  const toast = useToast();

  const {
    data: results = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', query, album],
    queryFn: () => workerApiClient.search({ q: query, album }),
    enabled: false,
  });

  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
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
            <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={4}>
              <FormControl id="album-select">
                <FormLabel>Album</FormLabel>
                <Select
                  aria-label="Select photo album"
                  name="album"
                  placeholder="Select Album"
                  value={album}
                  onChange={(e) => setAlbum(e.target.value)}
                >
                  {albums.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Search</FormLabel>
                <ChakraInput
                  placeholder="Search photos..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSearch();
                    }
                  }}
                />
              </FormControl>
              <Box pt={{ base: 0, md: 8 }}>
                <Button w="100%" colorScheme="teal" onClick={handleSearch} isLoading={isLoading}>
                  Search
                </Button>
              </Box>
            </Grid>
          </Stack>
        </CardBody>
      </Card>

      {error && (
        <Text color="red.500">{error instanceof Error ? error.message : 'An error occurred'}</Text>
      )}

      <SimpleGrid columns={[1, 2, 3]} spacing={4}>
        {results.map((photo) => (
          <Box key={photo.id} borderWidth={1} borderRadius="lg" overflow="hidden">
            <Image
              src={workerApiClient.thumbnailUrl(photo)}
              alt={photo.description ?? photo.filename ?? photo.id}
              objectFit="cover"
              height="200px"
              width="100%"
            />
            <Box p={4}>
              <Text fontSize="sm" mb={2}>
                {photo.description}
              </Text>
              <Stack direction="row" flexWrap="wrap" gap={2}>
                {photo.tags.map((tag) => (
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
