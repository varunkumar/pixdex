import { usePageTitle } from '../hooks/usePageTitle';
import { Alert, Button, Card, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useMe } from '../hooks/useMe';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { AccessRequest } from '../types/api';
import InlineConfirm from './InlineConfirm';
import PageLoading from './PageLoading';
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
  const { email: myEmail, admin, loading } = useMe();
  const me = myEmail?.toLowerCase() ?? null;
  usePageTitle(loading ? undefined : admin ? 'Access requests' : 'Page not found');
  // The tab lives in the address, so Back and a reload keep it; Pending is the plain address.
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.status === params.get('status')) ?? TABS[0];
  const status = tab.status;
  const setStatus = (next: Status) => {
    setConfirming(null);
    setParams(next === 'pending' ? {} : { status: next });
  };
  // The row awaiting "revoke?", tied to this history entry so Back never returns to an armed question.
  const { key } = useLocation();
  const [confirming, setConfirming] = useState<{ id: number; key: string } | null>(null);

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

  if (loading) return <PageLoading label="Loading" />;
  if (!admin)
    return (
      <Title order={1} fz="md" fw={400}>
        Page not found.
      </Title>
    );

  // One decision at a time: the Worker edits the Access group read-then-write.
  const busy = decide.isPending;

  return (
    <Stack gap="md">
      <Title order={1} size="h2">Access requests</Title>
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
      {requests.isPending && <PageLoading label="Loading requests" />}
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
              {/* Hidden, never disabled: the admin cannot revoke themselves (the Worker answers 400 too). */}
              {tab.actions
                .filter((action) => !(action === 'revoke' && r.email.toLowerCase() === me))
                .map((action) => (
                  <Button
                    key={action}
                    size="xs"
                    variant={action === 'approve' ? 'filled' : 'light'}
                    color={action === 'approve' ? undefined : 'red'}
                    aria-label={`${LABEL[action]} ${r.email}`}
                    disabled={busy}
                    onClick={() =>
                      action === 'revoke' ? setConfirming({ id: r.id, key }) : decide.mutate({ id: r.id, action })
                    }
                  >
                    {LABEL[action]}
                  </Button>
                ))}
            </Group>
          </Group>
          {confirming?.id === r.id && confirming.key === key && (
            <InlineConfirm
              message={`Revoke ${r.email}? They are signed out at once.`}
              confirmLabel="Confirm revoke"
              loading={busy}
              onConfirm={() =>
                decide.mutate({ id: r.id, action: 'revoke' }, { onSettled: () => setConfirming(null) })
              }
              onCancel={() => setConfirming(null)}
            />
          )}
        </Card>
      ))}
    </Stack>
  );
};

export default AdminAccess;
