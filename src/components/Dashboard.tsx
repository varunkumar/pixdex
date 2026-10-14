import { Anchor, Card, Image, SimpleGrid, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { shortDescription } from '../services/text';
import { BRAND } from '../theme';

const RECENT_COUNT = 12;

const Stat = ({ label, value, to }: { label: string; value: number; to: string }) => (
  <UnstyledButton component={Link} to={to}>
    <Text size="sm" c="dimmed">
      {label}
    </Text>
    <Text fz={32} fw={700} lh={1.1}>
      {value}
    </Text>
  </UnstyledButton>
);

const Dashboard = () => {
  const { data: albums } = useQuery({
    queryKey: ['albums-page', 1, 1],
    queryFn: () => workerApiClient.getAlbumsPage({ limit: 1 }),
  });

  const { data: recent } = useQuery({
    queryKey: ['recent-photos'],
    queryFn: () => workerApiClient.searchPage({ limit: RECENT_COUNT }),
  });

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Title order={3} mb="md">
          {BRAND}
        </Title>
        <SimpleGrid cols={2}>
          <Stat label="Photos" value={recent?.total ?? 0} to="/search" />
          <Stat label="Albums" value={albums?.total ?? 0} to="/albums" />
        </SimpleGrid>
      </Card>

      {recent && recent.results.length > 0 && (
        <Card withBorder>
          <Title order={4} mb="md">
            Recently indexed
          </Title>
          <SimpleGrid cols={{ base: 2, md: 4, lg: 6 }} spacing="sm">
            {recent.results.map((photo) => (
              <Anchor key={photo.id} component={Link} to={`/photos/${photo.id}`} underline="never" c="inherit">
                <Image
                  src={workerApiClient.thumbnailUrl(photo)}
                  alt={shortDescription(photo.description, 80) || photo.filename || 'Photo'}
                  radius="md"
                  fit="contain"
                  h={120}
                  bg="var(--mantine-color-default-hover)"
                />
                {photo.album && (
                  <Text size="xs" lineClamp={1} mt={4}>
                    {photo.album}
                  </Text>
                )}
              </Anchor>
            ))}
          </SimpleGrid>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {[
          { to: '/search', label: 'Search' },
          { to: '/albums', label: 'Albums' },
          { to: '/daily', label: 'Daily Pick' },
        ].map(({ to, label }) => (
          <Card key={to} withBorder component={Link} to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
            {label}
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
};

export default Dashboard;
