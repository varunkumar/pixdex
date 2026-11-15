import { Alert, Button, Card, Group, Loader, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../hooks/useMe';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { AccessRequest } from '../types/api';
import { UserAvatar } from './UserAvatar';

type Status = AccessRequest['status'];
type Action = 'approve' | 'deny' | 'revoke';

const TABS: { status: Status; label: string; actions: Action[]; empty: string }[] = [
  { status: 'pending', label: 'Pending', actions: ['approve', 'deny'], empty: 'No pending requests.' },
  { status: 'approved', label: 'Approved', actions: ['revoke'], empty: 'No approved requests.' },
  { status: 'denied', label: 'Denied', actions: ['approve'], empty: 'No denied requests.' },
  { status: 'revoked', label: 'Revoked', actions: ['approve'], empty: 'No revoked requests.' },
];

const LABEL: Record<Action, string> = { approve: 'Approve', deny: 'Deny', revoke: 'Revoke' };

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Admin-only list of access requests with approve, deny and revoke. */
const AdminAccess = () => {
  const queryClient = useQueryClient();
  const { admin, loading } = useMe();
  const [status, setStatus] = useState<Status>('pending');
  const tab = TABS.find((t) => t.status === status) ?? TABS[0];

  // Gated on admin: a non-admin makes no admin call at all.
  const requests = useQuery({
    queryKey: ['access-requests', status],
    queryFn: () => workerApiClient.listAccessRequests(status),
    enabled: admin,
  });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: Action }) => workerApiClient.decideAccessRequest(id, action),
    // Any outcome refetches (a 409, 404 or 502 means the shown row may be stale); the returned promise keeps
    // the buttons disabled until the refetch finishes.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['access-requests'] }),
    onError: () =>
      notifications.show({
        color: 'red',
        title: 'Access change failed',
        message: 'The action did not complete and can be retried. Check the lists for the current state.',
      }),
  });

  if (loading) return <Loader size="sm" aria-label="Loading" />;
  if (!admin) return <Text>Page not found.</Text>;

  // One decision at a time: the Worker edits the Access group read-then-write.
  const busy = decide.isPending;

  return (
    <Stack gap="md">
      <Title order={2}>Access requests</Title>
      <Tabs value={status} onChange={(v) => v && setStatus(v as Status)}>
        <Tabs.List>
          {TABS.map((t) => (
            <Tabs.Tab key={t.status} value={t.status}>
              {t.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {requests.data?.queueFull && (
        <Alert color="yellow" title="Pending queue is full">
          The pending queue is full, so new requests are being turned away until you approve or deny some.
        </Alert>
      )}
      {requests.isError && <Alert color="red">Could not load requests.</Alert>}
      {requests.isPending && <Loader size="sm" aria-label="Loading requests" />}
      {requests.data && requests.data.requests.length === 0 && <Text c="dimmed">{tab.empty}</Text>}

      {requests.data?.requests.map((r) => (
        <Card key={r.id} withBorder padding="sm">
          <Group gap="sm" wrap="wrap" align="flex-start" justify="space-between">
            <Group gap="sm" wrap="nowrap" align="flex-start" style={{ flex: '1 1 260px', minWidth: 0 }}>
              <UserAvatar email={r.email} tooltip={false} />
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ wordBreak: 'break-all' }}>
                  {r.email}
                </Text>
                {r.note && (
                  <Text size="sm" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {r.note}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  Requested {formatDate(r.createdAt)}
                </Text>
              </Stack>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {tab.actions.map((action) => (
                <Button
                  key={action}
                  size="xs"
                  variant={action === 'approve' ? 'filled' : 'light'}
                  color={action === 'approve' ? undefined : 'red'}
                  aria-label={`${LABEL[action]} ${r.email}`}
                  disabled={busy}
                  onClick={() => decide.mutate({ id: r.id, action })}
                >
                  {LABEL[action]}
                </Button>
              ))}
            </Group>
          </Group>
        </Card>
      ))}
    </Stack>
  );
};

export default AdminAccess;
