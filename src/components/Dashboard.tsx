import {
  Card,
  CardBody,
  CardHeader,
  Grid,
  Heading,
  Image,
  Link,
  SimpleGrid,
  Stat,
  StatLabel,
  StatNumber,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { shortDescription } from '../services/text';

const RECENT_COUNT = 12;

const Dashboard = () => {
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  const { data: recent } = useQuery({
    queryKey: ['recent-photos'],
    queryFn: () => workerApiClient.searchPage({ limit: RECENT_COUNT }),
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Card>
        <CardHeader>
          <Heading size="md">pixdex</Heading>
        </CardHeader>
        <CardBody>
          <Grid templateColumns="repeat(2, 1fr)" gap={4}>
            <Link as={RouterLink} to="/search" textDecoration="none" _hover={{ textDecoration: 'none' }}>
              <Stat cursor="pointer">
                <StatLabel>Photos</StatLabel>
                <StatNumber>{recent?.total ?? 0}</StatNumber>
              </Stat>
            </Link>
            <Link as={RouterLink} to="/albums" textDecoration="none" _hover={{ textDecoration: 'none' }}>
              <Stat cursor="pointer">
                <StatLabel>Albums</StatLabel>
                <StatNumber>{albums.length}</StatNumber>
              </Stat>
            </Link>
          </Grid>
        </CardBody>
      </Card>

      {recent && recent.results.length > 0 && (
        <Card>
          <CardHeader>
            <Heading size="sm">Recently indexed</Heading>
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={{ base: 2, md: 4, lg: 6 }} spacing={3}>
              {recent.results.map((photo) => (
                <Link key={photo.id} as={RouterLink} to={`/photos/${photo.id}`}>
                  <Image
                    src={workerApiClient.thumbnailUrl(photo)}
                    alt={shortDescription(photo.description, 80) || photo.filename || 'Photo'}
                    borderRadius="md"
                    objectFit="contain"
                    bg="blackAlpha.100"
                    w="100%"
                    h="120px"
                  />
                  {photo.album && (
                    <Text fontSize="xs" noOfLines={1} mt={1}>
                      {photo.album}
                    </Text>
                  )}
                </Link>
              ))}
            </SimpleGrid>
          </CardBody>
        </Card>
      )}

      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={4}>
        <Link as={RouterLink} to="/search">
          <Card>
            <CardBody>Search</CardBody>
          </Card>
        </Link>
        <Link as={RouterLink} to="/albums">
          <Card>
            <CardBody>Albums</CardBody>
          </Card>
        </Link>
        <Link as={RouterLink} to="/daily">
          <Card>
            <CardBody>Daily Pick</CardBody>
          </Card>
        </Link>
      </Grid>
    </VStack>
  );
};

export default Dashboard;
