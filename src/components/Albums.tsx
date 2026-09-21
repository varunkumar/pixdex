import { Box, Card, CardBody, Grid, Heading, Link, Text, VStack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';

const Albums = () => {
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Box>
        <Heading size="lg">Albums</Heading>
      </Box>

      <Grid templateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={6}>
        {albums.map((album) => (
          <Link
            key={album}
            as={RouterLink}
            to={`/search?${new URLSearchParams({ album }).toString()}`}
            textDecoration="none"
            _hover={{ textDecoration: 'none' }}
          >
            <Card>
              <CardBody>
                <Text fontSize="lg">{album}</Text>
              </CardBody>
            </Card>
          </Link>
        ))}
      </Grid>
    </VStack>
  );
};

export default Albums;
