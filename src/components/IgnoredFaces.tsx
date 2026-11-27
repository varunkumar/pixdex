import { Button, Group, Stack, Text } from '@mantine/core';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { refreshAfterRestoring } from '../services/matchQueue';
import { errorMessage } from '../services/peopleKeys';
import FaceTile from './FaceTile';

/** The caller's ignored faces, with undo. Closed by default, so the People page makes no extra request. */
const IgnoredFaces = () => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['ignored-faces'],
    queryFn: ({ pageParam }) => workerApiClient.getIgnoredFaces(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: (ids: string[]) => workerApiClient.restoreFaces(ids),
    // Also after a failure: earlier batches may have been saved.
    onSettled: () => refreshAfterRestoring(queryClient),
  });
  const faces = query.data?.pages.flatMap((p) => p.faces) ?? [];

  return (
    <Stack gap="sm">
      <Button variant="subtle" color="gray" size="xs" w="fit-content" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Ignored faces
      </Button>
      {open && (
        <>
          {query.error != null && (
            <Text size="sm" c="red">
              Could not load ignored faces
            </Text>
          )}
          {query.isSuccess && faces.length === 0 && !query.hasNextPage && (
            <Text size="sm" c="dimmed">
              No ignored faces.
            </Text>
          )}
          <Group gap="sm" align="flex-start">
            {faces.map((f, i) => (
              <Stack key={f.id} gap={4} align="center">
                <Link to={`/photos/${f.photoId}`} aria-label={`Open the photo of ignored face ${i + 1}`}>
                  <FaceTile face={f} size={64} />
                </Link>
                <Button
                  size="compact-xs"
                  variant="light"
                  disabled={restore.isPending}
                  aria-label={`Restore ignored face ${i + 1}`}
                  onClick={() => restore.mutate([f.id])}
                >
                  Restore
                </Button>
              </Stack>
            ))}
          </Group>
          {(faces.length > 0 || query.hasNextPage) && (
            <Group gap="xs">
              {faces.length > 0 && (
                <Button size="xs" variant="light" disabled={restore.isPending} onClick={() => restore.mutate(faces.map((f) => f.id))}>
                  Restore all shown
                </Button>
              )}
              {query.hasNextPage && (
                <Button size="xs" variant="subtle" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Load more
                </Button>
              )}
            </Group>
          )}
          {restore.error && (
            <Text size="xs" c="red">
              {errorMessage(restore.error, false)}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
};

export default IgnoredFaces;
