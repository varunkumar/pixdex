import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';

const post = (body: unknown, token: string = env.INGEST_TOKEN) =>
  SELF.fetch('https://example.com/ingest/known-people', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /ingest/known-people', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM known_people').run();
  });

  it('upserts twice with a changed name and leaves one row', async () => {
    const first = await post({ people: [{ id: 'Q1', name: 'Old Name', aliases: [] }] });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ upserted: 1 });
    await post({ people: [{ id: 'Q1', name: 'New Name', aliases: [] }] });
    const { results } = await env.DB.prepare('SELECT id, name FROM known_people').all();
    expect(results).toEqual([{ id: 'Q1', name: 'New Name' }]);
  });

  it('keeps created_at on update and stores aliases as JSON', async () => {
    await post({ people: [{ id: 'Q2', name: 'A', aliases: ['x', 'y'] }] });
    const a = await env.DB.prepare('SELECT aliases, created_at FROM known_people WHERE id = ?').bind('Q2').first<{ aliases: string; created_at: string }>();
    expect(JSON.parse(a!.aliases)).toEqual(['x', 'y']);
    await post({ people: [{ id: 'Q2', name: 'A', aliases: ['z'] }] });
    const b = await env.DB.prepare('SELECT aliases, created_at FROM known_people WHERE id = ?').bind('Q2').first<{ aliases: string; created_at: string }>();
    expect(JSON.parse(b!.aliases)).toEqual(['z']);
    expect(b!.created_at).toBe(a!.created_at);
  });

  it('upserts 500 people in one request', async () => {
    const people = Array.from({ length: 500 }, (_, i) => ({ id: `Q${i + 10}`, name: `P${i}`, aliases: [] }));
    expect(await (await post({ people })).json()).toEqual({ upserted: 500 });
  });

  it('rejects 501 people, empty list and bad fields with 400', async () => {
    const people = Array.from({ length: 501 }, (_, i) => ({ id: `Q${i}`, name: 'n', aliases: [] }));
    expect((await post({ people })).status).toBe(400);
    expect((await post({ people: [] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: '', aliases: [] }] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: Array(21).fill('a') }] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: ['a'.repeat(101)] }] })).status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await SELF.fetch('https://example.com/ingest/known-people', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 with the read token or no token', async () => {
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: [] }] }, env.READ_TOKEN)).status).toBe(401);
    const res = await SELF.fetch('https://example.com/ingest/known-people', { method: 'POST', headers: readHeaders(), body: '{}' });
    expect(res.status).toBe(401);
  });
});
