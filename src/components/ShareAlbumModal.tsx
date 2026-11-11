import { Alert, Button, Group, Modal, Stack, TagsInput, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  album: string;
  sharedWith: string[];
  opened: boolean;
  onClose: () => void;
}

/** Owner-only dialog to set which Google sign-in emails can view an album. */
const ShareAlbumModal = ({ album, sharedWith, opened, onClose }: Props) => {
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState<string[]>(sharedWith);
  const [invalid, setInvalid] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => workerApiClient.setAlbumShares(album, emails),
    onSuccess: () => {
      for (const key of ['albums-page', 'album-summary']) void queryClient.invalidateQueries({ queryKey: [key] });
      onClose();
    },
  });

  const onChange = (next: string[]) => {
    const bad = next.find((e) => !EMAIL_RE.test(e.trim()));
    if (bad) {
      setInvalid(`"${bad}" is not a valid email address`);
      setEmails(next.filter((e) => EMAIL_RE.test(e.trim())));
      return;
    }
    setInvalid(null);
    setEmails(next);
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`Share "${album}"`}>
      <Stack gap="sm">
        <TagsInput
          label="Email addresses"
          placeholder="Type an email and press Enter"
          value={emails}
          onChange={onChange}
          error={invalid}
          splitChars={[',', ' ']}
        />
        <Text size="sm" c="dimmed">
          Each address must match the person's Google sign-in email. They can view this album but not change it.
        </Text>
        {save.error && <Alert color="red">{save.error instanceof Error ? save.error.message : 'Could not save'}</Alert>}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default ShareAlbumModal;
