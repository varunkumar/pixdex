import {
  Box,
  Button,
  Card,
  CardBody,
  Divider,
  Flex,
  Heading,
  Image,
  Link,
  SimpleGrid,
  Skeleton,
  Stack,
  Tag,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { exposureSummary, formatPhotoDate, mapsUrl } from '../services/exif';
import { getOriginalUrl } from '../services/originals';

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <Box>
    <Text fontSize="xs" color="gray.500" textTransform="uppercase">
      {label}
    </Text>
    <Text fontSize="sm">{children}</Text>
  </Box>
);

const TagList = ({ items, colorScheme }: { items: unknown[]; colorScheme?: string }) =>
  items.length === 0 ? null : (
    <Stack direction="row" flexWrap="wrap" gap={2}>
      {items.map((item) => (
        <Tag key={String(item)} size="sm" colorScheme={colorScheme}>
          {String(item)}
        </Tag>
      ))}
    </Stack>
  );

const PhotoDetail = () => {
  const { id = '' } = useParams();
  const {
    data: photo,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['photo', id],
    queryFn: () => workerApiClient.getPhoto(id),
    enabled: id !== '',
  });

  if (isLoading) {
    return (
      <VStack align="stretch" spacing={4}>
        <Skeleton height="360px" />
        <Skeleton height="120px" />
      </VStack>
    );
  }

  if (error || !photo) {
    return (
      <VStack align="start" spacing={4}>
        <Text color="red.500">
          {error instanceof Error ? error.message : 'Photo not found'}
        </Text>
        <Link as={RouterLink} to="/search" color="teal.500">
          Back to search
        </Link>
      </VStack>
    );
  }

  const originalUrl = getOriginalUrl(photo);
  const date = formatPhotoDate(photo.dateTime);
  const location = mapsUrl(photo);
  const exposure = exposureSummary(photo);
  const size = formatBytes(photo.fileSize);
  const dimensions = photo.width && photo.height ? `${photo.width} × ${photo.height}` : null;

  return (
    <VStack align="stretch" spacing={6}>
      <Link as={RouterLink} to="/search" color="teal.500" fontSize="sm">
        ← Back to search
      </Link>

      <Card>
        <CardBody>
          <Stack direction={{ base: 'column', lg: 'row' }} spacing={6} align="start">
            <Image
              src={workerApiClient.thumbnailUrl(photo)}
              alt={photo.filename ?? photo.id}
              objectFit="contain"
              bg="blackAlpha.100"
              borderRadius="md"
              maxH="600px"
              w={{ base: '100%', lg: '55%' }}
            />

            <VStack align="stretch" spacing={4} flex={1}>
              <Heading size="md">{photo.filename ?? 'Photo'}</Heading>

              <SimpleGrid columns={2} spacing={3}>
                {date && <Field label="Taken">{date}</Field>}
                {photo.album && (
                  <Field label="Album">
                    <Link
                      as={RouterLink}
                      to={`/search?${new URLSearchParams({ album: photo.album }).toString()}`}
                      color="teal.500"
                    >
                      {photo.album}
                    </Link>
                  </Field>
                )}
                {photo.cameraModel && <Field label="Camera">{photo.cameraModel}</Field>}
                {photo.lensModel && <Field label="Lens">{photo.lensModel}</Field>}
                {exposure.length > 0 && <Field label="Exposure">{exposure.join(' · ')}</Field>}
                {location && (
                  <Field label="Location">
                    <Link href={location} isExternal color="teal.500">
                      View on map
                    </Link>
                  </Field>
                )}
                {dimensions && <Field label="Dimensions">{dimensions}</Field>}
                {size && <Field label="File size">{size}</Field>}
                {photo.format && <Field label="Format">{photo.format.toUpperCase()}</Field>}
                {photo.season && <Field label="Season">{photo.season}</Field>}
                {/* Unknown (null) is left out entirely rather than shown as "Unknown". */}
                {photo.hasWatermark != null && (
                  <Field label="Watermark">{photo.hasWatermark ? 'Yes' : 'No'}</Field>
                )}
              </SimpleGrid>

              {originalUrl && (
                <Link href={originalUrl} isExternal color="teal.500" fontSize="sm">
                  View Original
                </Link>
              )}
            </VStack>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <VStack align="stretch" spacing={4}>
            {photo.description && (
              <Box>
                <Heading size="sm" mb={2}>
                  Description
                </Heading>
                <Text>{photo.description}</Text>
              </Box>
            )}

            {photo.environment && (
              <Box>
                <Heading size="sm" mb={2}>
                  Environment
                </Heading>
                <Text>{photo.environment}</Text>
              </Box>
            )}

            <Divider />

            {photo.subjects.length > 0 && (
              <Box>
                <Heading size="sm" mb={2}>
                  Subjects
                </Heading>
                <TagList items={photo.subjects} colorScheme="teal" />
              </Box>
            )}
            {photo.tags.length > 0 && (
              <Box>
                <Heading size="sm" mb={2}>
                  Tags
                </Heading>
                <TagList items={photo.tags} />
              </Box>
            )}
            {photo.colors.length > 0 && (
              <Box>
                <Heading size="sm" mb={2}>
                  Colors
                </Heading>
                <TagList items={photo.colors} />
              </Box>
            )}
            {photo.patterns.length > 0 && (
              <Box>
                <Heading size="sm" mb={2}>
                  Patterns
                </Heading>
                <TagList items={photo.patterns} />
              </Box>
            )}
          </VStack>
        </CardBody>
      </Card>

      {(photo.suggestedCaption || photo.suggestedHashtags.length > 0) && (
        <Card>
          <CardBody>
            <VStack align="stretch" spacing={3}>
              <Heading size="sm">Suggested caption</Heading>
              <Textarea value={photo.suggestedCaption ?? ''} isReadOnly rows={4} />
              {photo.suggestedHashtags.length > 0 && (
                <Flex gap={2} flexWrap="wrap">
                  {photo.suggestedHashtags.map((tag) => (
                    <Tag key={tag} colorScheme="teal">
                      #{tag}
                    </Tag>
                  ))}
                </Flex>
              )}
              <Button
                alignSelf="start"
                colorScheme="teal"
                onClick={() => {
                  const hashtags = photo.suggestedHashtags.map((t) => `#${t}`).join(' ');
                  void navigator.clipboard.writeText(`${photo.suggestedCaption ?? ''}\n\n${hashtags}`.trim());
                }}
              >
                Copy to Clipboard
              </Button>
            </VStack>
          </CardBody>
        </Card>
      )}
    </VStack>
  );
};

export default PhotoDetail;
