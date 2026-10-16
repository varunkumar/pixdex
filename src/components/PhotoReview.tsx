import { Badge, Button, Card, Group, Rating, Stack, TagsInput, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { PhotoReviewPatch, SerializedPhoto } from '../types/api';

/** Human-in-the-loop corrections: star rating plus overrides for the AI's title, subjects and tags. */
const PhotoReview = ({ photo }: { photo: SerializedPhoto }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: (patch: PhotoReviewPatch) => workerApiClient.updatePhoto(photo.id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['photo', photo.id], updated);
      // Ratings and overrides change ordering and text everywhere photos are listed.
      for (const key of ['search', 'album-photos', 'albums-page', 'dailyPick', 'recent-photos']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      setEditing(false);
    },
  });

  const overrides = photo.overrides;
  const edited = !!overrides && (overrides.shortCaption != null || overrides.subjects != null || overrides.tags != null);

  const startEditing = () => {
    setCaption(photo.shortCaption ?? '');
    setSubjects(photo.subjects);
    setTags(photo.tags);
    setEditing(true);
  };

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>Your review {edited && <Badge ml="xs" variant="light">edited</Badge>}</Title>
          {!editing && (
            <Button size="xs" variant="light" onClick={startEditing}>
              Edit details
            </Button>
          )}
        </Group>

        <Group gap="sm">
          <Rating
            aria-label="Your rating"
            value={photo.userRating ?? 0}
            onChange={(value) => save.mutate({ userRating: value })}
            size="lg"
          />
          {photo.userRating != null && (
            <Button size="compact-xs" variant="subtle" onClick={() => save.mutate({ userRating: null })}>
              Clear rating
            </Button>
          )}
          {photo.combinedScore != null && (
            <Text size="sm" c="dimmed">
              Overall {photo.combinedScore.toFixed(1)} / 10
              {photo.userRating != null ? ' (your stars + AI aesthetics)' : ' (AI aesthetics only)'}
            </Text>
          )}
        </Group>

        {editing && (
          <Stack gap="sm">
            <TextInput label="Title" value={caption} maxLength={80} onChange={(e) => setCaption(e.currentTarget.value)} />
            <TagsInput label="Subjects (species)" value={subjects} onChange={setSubjects} />
            <TagsInput label="Tags" value={tags} onChange={setTags} />
            <Group gap="sm">
              <Button
                loading={save.isPending}
                onClick={() => save.mutate({ caption: caption.trim() || null, subjects, tags })}
              >
                Save
              </Button>
              <Button variant="default" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {edited && (
                <Button
                  variant="subtle"
                  color="red"
                  loading={save.isPending}
                  onClick={() => save.mutate({ caption: null, subjects: null, tags: null })}
                >
                  Reset to AI
                </Button>
              )}
            </Group>
          </Stack>
        )}

        {save.error && <Text c="red">{save.error instanceof Error ? save.error.message : 'Could not save'}</Text>}
      </Stack>
    </Card>
  );
};

export default PhotoReview;
