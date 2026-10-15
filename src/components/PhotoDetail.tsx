import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePrefetchImage } from '../hooks/usePrefetchImage';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { exposureSummary, formatPhotoDate, mapsUrl } from '../services/exif';
import { getOriginalImageUrl, getOriginalUrl } from '../services/originals';
import Lightbox from './Lightbox';

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <Box>
    <Text size="xs" c="dimmed" tt="uppercase">
      {label}
    </Text>
    <Text size="sm">{children}</Text>
  </Box>
);

const Section = ({ title, items, variant }: { title: string; items: unknown[]; variant?: 'light' | 'outline' }) =>
  items.length === 0 ? null : (
    <Box>
      <Title order={5} mb="xs">
        {title}
      </Title>
      <Group gap="xs">
        {items.map((item) => (
          <Badge key={String(item)} variant={variant ?? 'light'} size="lg" tt="none">
            {String(item)}
          </Badge>
        ))}
      </Group>
    </Box>
  );

const PhotoDetail = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data: photo,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['photo', id],
    queryFn: () => workerApiClient.getPhoto(id),
    enabled: id !== '',
  });

  // history.state.idx is the entry's position in this tab (React Router browser history);
  // a replace gives the entry a new key, so the key alone is not a reliable signal.
  const historyIdx = (window.history.state as { idx?: number } | null)?.idx;
  const canGoBack = typeof historyIdx === 'number' ? historyIdx > 0 : location.key !== 'default';

  const originalImage = photo ? getOriginalImageUrl(photo) : null;
  const originalStatus = usePrefetchImage(originalImage);
  const lightboxOpen = searchParams.get('lightbox') === '1';

  const openLightbox = () => navigate({ search: '?lightbox=1' }, { state: { lightbox: true } });
  const closeLightbox = () => {
    if ((location.state as { lightbox?: boolean } | null)?.lightbox) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('lightbox');
    setSearchParams(next, { replace: true });
  };

  if (isLoading) {
    return (
      <Stack>
        <Skeleton height={360} />
        <Skeleton height={120} />
      </Stack>
    );
  }

  if (error || !photo) {
    return (
      <Stack align="flex-start">
        <Text c="red">{error instanceof Error ? error.message : 'Photo not found'}</Text>
        {canGoBack ? (
          <Anchor component="button" type="button" onClick={() => navigate(-1)}>
            ← Back
          </Anchor>
        ) : (
          <Anchor component={Link} to="/search">
            Back to search
          </Anchor>
        )}
      </Stack>
    );
  }

  const originalUrl = getOriginalUrl(photo);
  const date = formatPhotoDate(photo.dateTime);
  const gps = mapsUrl(photo);
  const exposure = exposureSummary(photo);
  const size = formatBytes(photo.fileSize);
  const dimensions = photo.width && photo.height ? `${photo.width} × ${photo.height}` : null;
  const albumHref = photo.album ? `/albums/${encodeURIComponent(photo.album)}` : null;
  const thumbnail = workerApiClient.thumbnailUrl(photo);
  const alt = photo.filename ?? photo.id;

  return (
    <Stack gap="lg">
      {canGoBack ? (
        <Anchor component="button" type="button" size="sm" onClick={() => navigate(-1)} w="fit-content">
          ← Back
        </Anchor>
      ) : (
        <Anchor component={Link} to={albumHref ?? '/search'} size="sm" w="fit-content">
          {albumHref ? '← Back to album' : '← Back to search'}
        </Anchor>
      )}

      <Card withBorder>
        <Group align="flex-start" wrap="wrap" gap="lg">
          <UnstyledButton
            onClick={openLightbox}
            aria-label="Open full-size photo"
            style={{ cursor: 'zoom-in', flex: '1 1 320px', maxWidth: '100%' }}
          >
            <Image
              src={thumbnail}
              alt={alt}
              fit="contain"
              radius="md"
              mah={600}
              bg="var(--mantine-color-default-hover)"
            />
          </UnstyledButton>

          <Stack gap="md" style={{ flex: '1 1 280px' }}>
            <Title order={3}>{photo.shortCaption ?? photo.filename ?? 'Photo'}</Title>

            <SimpleGrid cols={2} spacing="sm">
              {photo.filename && <Field label="File name">{photo.filename}</Field>}
              {date && <Field label="Taken">{date}</Field>}
              {photo.album && albumHref && (
                <Field label="Album">
                  <Anchor component={Link} to={albumHref}>
                    {photo.album}
                  </Anchor>
                </Field>
              )}
              {photo.cameraModel && <Field label="Camera">{photo.cameraModel}</Field>}
              {photo.lensModel && <Field label="Lens">{photo.lensModel}</Field>}
              {exposure.length > 0 && <Field label="Exposure">{exposure.join(' · ')}</Field>}
              {gps && (
                <Field label="Location">
                  <Anchor href={gps} target="_blank" rel="noopener noreferrer">
                    View on map
                  </Anchor>
                </Field>
              )}
              {dimensions && <Field label="Dimensions">{dimensions}</Field>}
              {size && <Field label="File size">{size}</Field>}
              {photo.format && <Field label="Format">{photo.format.toUpperCase()}</Field>}
              {photo.season && <Field label="Season">{photo.season}</Field>}
              {/* Unknown (null) is left out entirely rather than shown as "Unknown". */}
              {photo.hasWatermark != null && <Field label="Watermark">{photo.hasWatermark ? 'Yes' : 'No'}</Field>}
            </SimpleGrid>

            {originalUrl && (
              <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer" size="sm">
                View Original
              </Anchor>
            )}
          </Stack>
        </Group>
      </Card>

      <Card withBorder>
        <Stack gap="md">
          {photo.description && (
            <Box>
              <Title order={5} mb="xs">
                Description
              </Title>
              <Text>{photo.description}</Text>
            </Box>
          )}
          {photo.environment && (
            <Box>
              <Title order={5} mb="xs">
                Environment
              </Title>
              <Text>{photo.environment}</Text>
            </Box>
          )}
          <Divider />
          <Section title="Subjects" items={photo.subjects} />
          <Section title="Tags" items={photo.tags} variant="outline" />
          <Section title="Colors" items={photo.colors} variant="outline" />
          <Section title="Patterns" items={photo.patterns} variant="outline" />
        </Stack>
      </Card>

      {(photo.suggestedCaption || photo.suggestedHashtags.length > 0) && (
        <Card withBorder>
          <Stack gap="sm">
            <Title order={5}>Suggested caption</Title>
            <Textarea value={photo.suggestedCaption ?? ''} readOnly rows={4} />
            {photo.suggestedHashtags.length > 0 && (
              <Group gap="xs">
                {photo.suggestedHashtags.map((tag) => (
                  <Badge key={tag} variant="light">
                    #{tag}
                  </Badge>
                ))}
              </Group>
            )}
            <Button
              w="fit-content"
              onClick={() => {
                const hashtags = photo.suggestedHashtags.map((t) => `#${t}`).join(' ');
                void navigator.clipboard.writeText(`${photo.suggestedCaption ?? ''}\n\n${hashtags}`.trim());
              }}
            >
              Copy to Clipboard
            </Button>
          </Stack>
        </Card>
      )}

      <Lightbox
        opened={lightboxOpen}
        onClose={closeLightbox}
        thumbnailSrc={thumbnail}
        originalSrc={originalImage}
        originalStatus={originalStatus}
        alt={alt}
        fallbackHref={originalUrl}
      />
    </Stack>
  );
};

export default PhotoDetail;
