// Cloudflare Access API client (group membership and session revoke).
// API token permission: "Access: Organizations, Identity Providers, and Groups Write"
// (account scope). Docs list this one permission for both PUT access/groups/{id} and
// POST access/organizations/revoke_user, so no narrower token covers both.
// Only called from owner-only admin routes; never on a hot path, no D1.
import type { Env } from '../types';

export interface AccessApiConfig {
  token: string;
  accountId: string;
  groupId: string;
}

export class AccessApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AccessApiError';
    this.status = status;
  }
}

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
// Statuses treated as a concurrent-edit conflict (one retry). Cloudflare does not document one
// for this endpoint, so both common ones are listed here: change in one place if needed.
const CONFLICT_STATUSES = [409, 412];
// Read-only fields dropped from the GET result before the PUT; everything else is sent as returned.
const READ_ONLY_FIELDS = ['id', 'created_at', 'updated_at'];

type Rule = Record<string, unknown>;
type GroupResult = Record<string, unknown> & { include?: Rule[] };

export function accessApiConfig(env: Env): AccessApiConfig {
  const token = (env.CF_API_TOKEN ?? '').trim();
  const accountId = (env.CF_ACCOUNT_ID ?? '').trim();
  const groupId = (env.CF_ACCESS_GROUP_ID ?? '').trim();
  if (!token || !accountId || !groupId) {
    throw new Error('CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_GROUP_ID must all be set');
  }
  return { token, accountId, groupId };
}

async function call(cfg: AccessApiConfig, method: string, path: string, body?: unknown): Promise<GroupResult> {
  const res = await fetch(`${API_BASE}/${cfg.accountId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  type Envelope = { success?: boolean; result?: GroupResult };
  const json: Envelope | null = await res.json().then(
    (j) => j as Envelope,
    () => null
  );
  if (!res.ok || !json || json.success !== true) {
    throw new AccessApiError(`Cloudflare API ${method} ${path} failed (${res.status})`, res.status);
  }
  return json.result ?? {};
}

const groupPath = (cfg: AccessApiConfig) => `/access/groups/${cfg.groupId}`;
const emailOf = (rule: Rule): string | null => {
  const e = rule.email as { email?: unknown } | undefined;
  return e && typeof e.email === 'string' ? e.email.toLowerCase() : null;
};

async function editInclude(cfg: AccessApiConfig, change: (include: Rule[]) => Rule[] | null): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const group = await call(cfg, 'GET', groupPath(cfg));
    const next = change(group.include ?? []);
    if (next === null) return;
    const body: Record<string, unknown> = { ...group, include: next };
    for (const f of READ_ONLY_FIELDS) delete body[f];
    try {
      await call(cfg, 'PUT', groupPath(cfg), body);
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof AccessApiError && CONFLICT_STATUSES.includes(err.status)) continue;
      throw err;
    }
  }
}

export async function addGroupEmail(cfg: AccessApiConfig, email: string): Promise<void> {
  const target = email.trim().toLowerCase();
  await editInclude(cfg, (include) =>
    include.some((r) => emailOf(r) === target) ? null : [...include, { email: { email: target } }]
  );
}

export async function removeGroupEmail(cfg: AccessApiConfig, email: string): Promise<void> {
  const target = email.trim().toLowerCase();
  await editInclude(cfg, (include) =>
    include.some((r) => emailOf(r) === target) ? include.filter((r) => emailOf(r) !== target) : null
  );
}

export async function revokeUserSessions(cfg: AccessApiConfig, email: string): Promise<void> {
  await call(cfg, 'POST', '/access/organizations/revoke_user', { email: email.trim().toLowerCase() });
}
