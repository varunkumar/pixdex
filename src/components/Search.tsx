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
  Link,
  Select,
  SimpleGrid,
  Stack,
  Tag,
  Text,
  useToast,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { shortDescription } from '../services/text';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { getOriginalUrl } from '../services/originals';
import PhotoMeta from './PhotoMeta';

const MAX_LISTING_TAGS = 5;

const Search = () => {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [album, setAlbum] = useState(searchParams.get('album') ?? '');
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
            <Link as={RouterLink} to={`/photos/${photo.id}`} _hover={{ textDecoration: 'none' }} display="block">
              <Image
                src={workerApiClient.thumbnailUrl(photo)}
                alt={shortDescription(photo.description, 80) || photo.filename || photo.id}
                objectFit="contain"
                bg="blackAlpha.100"
                height="260px"
                width="100%"
              />
            </Link>
            <Box p={4}>
              <Link as={RouterLink} to={`/photos/${photo.id}`} color="inherit" _hover={{ textDecoration: 'none' }}>
                <Text fontSize="sm" mb={2}>
                  {shortDescription(photo.description)}
                </Text>
              </Link>
              <PhotoMeta photo={photo} compact />
              <Stack direction="row" flexWrap="wrap" gap={2}>
                {photo.tags.slice(0, MAX_LISTING_TAGS).map((tag) => (
                  <Tag key={tag} size="sm">
                    {tag}
                  </Tag>
                ))}
                {photo.tags.length > MAX_LISTING_TAGS && (
                  <Tag size="sm" variant="outline">
                    +{photo.tags.length - MAX_LISTING_TAGS}
                  </Tag>
                )}
              </Stack>
              {(() => {
                const originalUrl = getOriginalUrl(photo);
                return (
                  originalUrl && (
                    <Link href={originalUrl} isExternal fontSize="sm" color="teal.500" mt={2} display="inline-block">
                      View Original
                    </Link>
                  )
                );
              })()}
            </Box>
          </Box>
        ))}
      </SimpleGrid>
    </Box>
  );
};

export default Search;
