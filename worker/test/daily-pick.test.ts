import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seed(id: string, subjects: string[], description: string, instagramSuggested: string | null) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, description, suggested_caption, suggested_hashtags, model_provider, model_name, search_text, last_indexed, instagram_suggested)
     VALUES (?,?,'local',?,?,?, 'caption', '[]', 'ollama', 'qwen3.5:27b-mlx', '', '2026-09-18T00:00:00.000Z', ?)`
  )
    .bind(id, `hash-${id}`, `${id}.jpg`, JSON.stringify(subjects), description, instagramSuggested)
    .run();
}

describe('GET /daily-pick', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('picks the photo with more subjects and a longer description over a never-suggested sparse one', async () => {
    await seed('sparse', ['leopard'], 'A leopard.', null);
    await seed('rich', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets over the forest.', null);

    const response = await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    const body = (await response.json()) as any;
    expect(body.photo.id).toBe('rich');
    expect(body.suggestedCaption).toBe('caption');
  });

  it('skips a photo suggested within the last 90 days if another is eligible', async () => {
    // 10 days ago: recent enough to be within the 90-day cooldown, but not
    // "today" (today's date is reserved for the idempotent-per-day check).
    const recentlySuggested = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await seed('recent', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets.', recentlySuggested);
    await seed('eligible', ['leopard'], 'A leopard.', null);

    const response = await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    const body = (await response.json()) as any;
    expect(body.photo.id).toBe('eligible');
  });

  it('is stable within the same day (idempotent) across repeated calls', async () => {
    await seed('sparse', ['leopard'], 'A leopard.', null);
    await seed('rich', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets over the forest.', null);

    const first = (await (await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } })).json()) as any;
    const second = (await (await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } })).json()) as any;
    const third = (await (await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } })).json()) as any;

    expect(first.photo.id).toBe('rich');
    expect(second.photo.id).toBe('rich');
    expect(third.photo.id).toBe('rich');

    // Only the first call should have written instagram_suggested; the
    // idempotent-per-day path returns the same photo without re-picking.
    const row = await env.DB.prepare('SELECT instagram_suggested FROM photos WHERE id = ?')
      .bind('rich')
      .first<{ instagram_suggested: string }>();
    expect(row?.instagram_suggested).toBeTruthy();
  });

  it('returns the clean camelCase photo shape including thumbnailUrl', async () => {
    await seed('rich', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets over the forest.', null);

    const response = await SELF.fetch('https://example.com/daily-pick', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    const body = (await response.json()) as any;
    expect(body.photo.thumbnailUrl).toBe('/thumbnails/hash-rich');
    expect(body.photo.subjects).toEqual(['leopard', 'tree', 'sunset']);
    expect(body.photo.suggested_hashtags).toBeUndefined();
  });
});
