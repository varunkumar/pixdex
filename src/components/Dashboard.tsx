import { usePageTitle } from '../hooks/usePageTitle';
import { Anchor, Card, Group, Image, SimpleGrid, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { shortDescription } from '../services/text';
import { BRAND } from '../theme';
import InsightsSection from './insights/InsightsSection';

const RECENT_COUNT = 12;
/** Photos that load at once; the rest wait until they come near the viewport. */
const EAGER_PHOTOS = 4;

/** `value` is undefined until it has loaded: a dash, never a false zero. */
const Stat = ({ label, value, to }: { label: string; value: number | undefined; to: string }) => (
  <UnstyledButton component={Link} to={to} className="pdx-target" aria-label={`${label} ${value ?? '-'}`}>
    <Text component="span" size="sm" c="dimmed" mr={6}>
      {label}
    </Text>
    <Text component="span" fz="xl" fw={700}>
      {value ?? '-'}
    </Text>
  </UnstyledButton>
);

const Dashboard = () => {
  usePageTitle('Dashboard');
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
      <Group justify="space-between" align="baseline">
        <Title order={1} size="h3">
          {BRAND}
        </Title>
        <Group gap="lg">
          <Stat label="Photos" value={recent?.total} to="/search" />
          <Stat label="Albums" value={albums?.total} to="/albums" />
        </Group>
      </Group>

      <InsightsSection />

      {recent && recent.results.length > 0 && (
        <Card withBorder>
          <Title order={2} size="h4" mb="md">
            Recently indexed
          </Title>
          <SimpleGrid cols={{ base: 2, md: 4, lg: 6 }} spacing="sm">
            {recent.results.map((photo, i) => (
              <Anchor key={photo.id} component={Link} to={`/photos/${photo.id}`} underline="never" c="inherit">
                <Image
                  src={workerApiClient.thumbnailUrl(photo)}
                  alt={shortDescription(photo.description, 80) || photo.filename || 'Photo'}
                  radius="md"
                  fit="contain"
                  h={120}
                  bg="var(--mantine-color-default-hover)"
                  loading={i < EAGER_PHOTOS ? undefined : 'lazy'}
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
    </Stack>
  );
};

export default Dashboard;
