import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';

const upsertSchema = z.object({
  people: z
    .array(
      z.object({
        id: z.string().check(z.minLength(1), z.maxLength(64)),
        name: z.string().check(z.minLength(1), z.maxLength(200)),
        aliases: z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.maxLength(20)),
      })
    )
    .check(z.minLength(1), z.maxLength(500)),
});

async function readJson(c: Context<{ Bindings: Env }>): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Upserts the known-people list in one statement (json_each batching, at most 500 rows).
 * created_at is kept on update. The agent is the only caller (ingest token).
 */
export async function upsertKnownPeopleRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { people } = parsed.data;

  const payload = JSON.stringify(
    people.map((p) => ({ id: p.id, name: p.name, aliases: JSON.stringify(p.aliases) }))
  );
  await c.env.DB.prepare(
    `INSERT INTO known_people (id, name, aliases, created_at)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.aliases'), ?
     FROM json_each(?) WHERE true
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases`
  )
    .bind(new Date().toISOString(), payload)
    .run();

  return c.json({ upserted: people.length });
}
