import { ActionIcon, Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MdClose } from 'react-icons/md';
import { useMe } from '../hooks/useMe';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { UserAvatar } from './UserAvatar';

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
  const { email: me } = useMe();
  const [emails, setEmails] = useState<string[]>(sharedWith);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => workerApiClient.setAlbumShares(album, emails),
    onSuccess: () => {
      for (const key of ['albums-page', 'album-summary']) void queryClient.invalidateQueries({ queryKey: [key] });
      onClose();
    },
  });

  const add = () => {
    const value = draft.trim().toLowerCase();
    if (!value) return;
    if (!EMAIL_RE.test(value)) return setError(`"${value}" is not a valid email address`);
    if (value === me) return setError('You already own this album');
    setError(null);
    setDraft('');
    if (!emails.includes(value)) setEmails([...emails, value]);
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`Share "${album}"`}>
      <Stack gap="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Group align="flex-start" gap="xs" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              aria-label="Email address"
              placeholder="Type an email and press Enter"
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                setError(null);
              }}
              error={error}
            />
            <Button type="submit" variant="light">
              Add
            </Button>
          </Group>
        </form>

        <Stack gap="xs" aria-label="People with access">
          {me && (
            <Group gap="sm" wrap="nowrap">
              <UserAvatar email={me} tooltip={false} />
              <Text size="sm" style={{ flex: 1, wordBreak: 'break-all' }}>
                {me}
              </Text>
              <Text size="xs" c="dimmed">
                Owner
              </Text>
            </Group>
          )}
          {emails.map((e) => (
            <Group key={e} gap="sm" wrap="nowrap">
              <UserAvatar email={e} tooltip={false} />
              <Text size="sm" style={{ flex: 1, wordBreak: 'break-all' }}>
                {e}
              </Text>
              <Text size="xs" c="dimmed">
                Can view
              </Text>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={`Remove ${e}`}
                onClick={() => setEmails(emails.filter((x) => x !== e))}
              >
                <MdClose />
              </ActionIcon>
            </Group>
          ))}
          {emails.length === 0 && (
            <Text size="sm" c="dimmed">
              Not shared with anyone yet.
            </Text>
          )}
        </Stack>

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
