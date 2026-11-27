import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRequest, AccessRequestsResponse } from '../../types/api';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import AdminAccess from '../AdminAccess';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getMe: vi.fn(), listAccessRequests: vi.fn(), decideAccessRequest: vi.fn() },
}));

const row = (
  id: number,
  email: string,
  status: AccessRequest['status'] = 'pending',
  note: string | null = null
): AccessRequest => ({
  id,
  email,
  note,
  status,
  createdAt: '2026-11-10T08:00:00Z',
  decidedAt: null,
});

const list = (requests: AccessRequest[], queueFull = false): AccessRequestsResponse => ({
  requests,
  pendingCount: requests.filter((r) => r.status === 'pending').length,
  queueFull,
});

const show = () => renderWithProviders(<AdminAccess />);

describe('AdminAccess', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'admin@example.com', admin: true });
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(
      list([row(1, 'a@example.com', 'pending', 'Hello there'), row(2, 'b@example.com')])
    );
    vi.mocked(workerApiClient.decideAccessRequest).mockResolvedValue(row(1, 'a@example.com', 'approved'));
  });

  it('opens the tab named in the address and drops the name again for Pending', async () => {
    const { router } = renderWithRouter([{ path: '/admin/access', element: <AdminAccess /> }], ['/admin/access?status=revoked']);
    await waitFor(() => expect(workerApiClient.listAccessRequests).toHaveBeenCalledWith('revoked'));
    expect(screen.getByRole('tab', { name: 'Revoked' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    await waitFor(() => expect(router.state.location.search).toBe('?status=approved'));
    fireEvent.click(screen.getByRole('tab', { name: 'Pending' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('treats an unknown tab name as Pending', async () => {
    renderWithProviders(<AdminAccess />, { route: '/admin/access?status=nonsense' });
    await waitFor(() => expect(workerApiClient.listAccessRequests).toHaveBeenCalledWith('pending'));
  });

  it('lists pending rows with email, note and date, and Approve and Deny buttons', async () => {
    show();
    expect(await screen.findByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(workerApiClient.listAccessRequests).toHaveBeenCalledWith('pending');
    expect(screen.getAllByRole('button', { name: /^Approve/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Deny/ })).toHaveLength(2);
  });

  it('Approve calls decideAccessRequest and the row leaves after refetch', async () => {
    show();
    await screen.findByText('a@example.com');
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(2, 'b@example.com')]));
    fireEvent.click(screen.getByRole('button', { name: 'Approve a@example.com' }));
    await waitFor(() => expect(workerApiClient.decideAccessRequest).toHaveBeenCalledWith(1, 'approve'));
    await waitFor(() => expect(screen.queryByText('a@example.com')).toBeNull());
    expect(screen.getByText('b@example.com')).toBeInTheDocument();
  });

  it('shows the queue-full alert', async () => {
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(1, 'a@example.com')], true));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(/pending queue is full/i);
  });

  it('shows not found for a non-admin and makes no list call', async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'x@example.com', admin: false });
    show();
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(workerApiClient.listAccessRequests).not.toHaveBeenCalled();
  });

  it('disables every action button while a decision is in flight', async () => {
    vi.mocked(workerApiClient.decideAccessRequest).mockReturnValue(new Promise(() => {}));
    show();
    await screen.findByText('a@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Approve a@example.com' }));
    await waitFor(() => {
      for (const b of screen.getAllByRole('button', { name: /^(Approve|Deny) / })) expect(b).toBeDisabled();
    });
    expect(workerApiClient.decideAccessRequest).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable error notification that does not claim a state when the call fails', async () => {
    vi.mocked(workerApiClient.decideAccessRequest).mockRejectedValue(new Error('Could not save: 502'));
    show();
    await screen.findByText('a@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Approve a@example.com' }));
    expect(await screen.findByText(/did not complete.*retried/i)).toBeInTheDocument();
    expect(screen.queryByText(/was approved/i)).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve a@example.com' })).toBeEnabled());
  });

  it('refetches the list after a failed decision so stale rows disappear', async () => {
    vi.mocked(workerApiClient.decideAccessRequest).mockRejectedValue(new Error('Could not save: 409'));
    show();
    await screen.findByText('a@example.com');
    expect(workerApiClient.listAccessRequests).toHaveBeenCalledTimes(1);
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(2, 'b@example.com')]));
    fireEvent.click(screen.getByRole('button', { name: 'Approve a@example.com' }));
    await waitFor(() => expect(workerApiClient.listAccessRequests).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('a@example.com')).toBeNull());
  });

  it('renders a note as plain text, never markup', async () => {
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(
      list([row(1, 'a@example.com', 'pending', '<b>x</b>')])
    );
    const { container } = show();
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('switches tabs and offers Revoke on Approved and Approve on Denied and Revoked', async () => {
    show();
    await screen.findByText('a@example.com');
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(3, 'c@example.com', 'approved')]));
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    expect(await screen.findByRole('button', { name: 'Revoke c@example.com' })).toBeInTheDocument();
    expect(workerApiClient.listAccessRequests).toHaveBeenCalledWith('approved');
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(4, 'd@example.com', 'denied')]));
    fireEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    expect(await screen.findByRole('button', { name: 'Approve d@example.com' })).toBeInTheDocument();
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(list([row(5, 'e@example.com', 'revoked')]));
    fireEvent.click(screen.getByRole('tab', { name: 'Revoked' }));
    expect(await screen.findByRole('button', { name: 'Approve e@example.com' })).toBeInTheDocument();
  });

  it('hides Revoke on the signed-in admin own row (any letter case) and keeps it on other rows', async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'Admin@Example.com', admin: true });
    show();
    await screen.findByText('a@example.com');
    vi.mocked(workerApiClient.listAccessRequests).mockResolvedValue(
      list([row(6, 'admin@example.com', 'approved'), row(7, 'c@example.com', 'approved')])
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    expect(await screen.findByRole('button', { name: 'Revoke c@example.com' })).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke admin@example.com' })).not.toBeInTheDocument();
  });
});
