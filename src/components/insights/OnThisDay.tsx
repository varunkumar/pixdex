import { Anchor, Card, Image, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { shortDescription } from '../../services/text';
import type { OnThisDayResponse } from '../../types/api';

/** `date_time` is the camera clock read as India time (see the Worker's insights), so shift it back to show the day. */
const cameraDay = (dateTime: string) =>
  new Date(Date.parse(dateTime) + 330 * 60_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const OnThisDay = ({ data }: { data: OnThisDayResponse }) => {
  const current = Number(data.date.slice(0, 4));
  return (
    <Card withBorder>
      <Title order={2} size="h4" mb="sm">
        On this day
      </Title>
      <Stack gap="md">
        {data.years.map(({ year, photos }, index) => (
          <div key={year}>
            <Title order={3} fz="sm" mb="xs">
              {year} · {current - year} {current - year === 1 ? 'year' : 'years'} ago
            </Title>
            <div className="pdx-onthisday-row">
              {photos.map((photo, i) => (
                <Anchor key={photo.id} component={Link} to={`/photos/${photo.id}`} underline="never" c="inherit">
                  <Image
                    src={workerApiClient.thumbnailUrl(photo)}
                    alt={shortDescription(photo.description, 80) || photo.filename || 'Photo'}
                    radius="md"
                    h={110}
                    w={150}
                    fit="cover"
                    loading={index === 0 && i < 4 ? undefined : 'lazy'}
                  />
                  {photo.dateTime && (
                    <Text size="xs" c="dimmed" mt={2}>
                      {cameraDay(photo.dateTime)}
                    </Text>
                  )}
                </Anchor>
              ))}
            </div>
          </div>
        ))}
      </Stack>
    </Card>
  );
};

export default OnThisDay;
