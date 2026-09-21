import { Card, CardBody, CardHeader, Grid, Heading, Link, Stat, StatLabel, StatNumber, VStack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';

const Dashboard = () => {
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Card>
        <CardHeader>
          <Heading size="md">pixdex</Heading>
        </CardHeader>
        <CardBody>
          <Link as={RouterLink} to="/albums" textDecoration="none" _hover={{ textDecoration: 'none' }}>
            <Stat cursor="pointer">
              <StatLabel>Albums</StatLabel>
              <StatNumber>{albums.length}</StatNumber>
            </Stat>
          </Link>
        </CardBody>
      </Card>

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
