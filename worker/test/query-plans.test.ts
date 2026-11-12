import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MATCHABLE_SQL } from '../src/people/matching';
import { KNOWN_COUNTS_SQL } from '../src/routes/known';
import { photoAccess, scopeFor, visibleAlbumsSql } from '../src/db/visibility';

const U = { email: 'owner@example.com' };

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
  return r.results.map((x) => x.detail).join('\n');
}

describe('query plans (no unbounded scans on the new owner paths)', () => {
  it('canEditFor and visibleAlbumsSql search idx_albums_owner_email', async () => {
    expect(await plan('SELECT name FROM albums WHERE owner_email = ?', U.email)).toMatch(/SEARCH albums USING (COVERING )?INDEX idx_albums_owner_email/);
    const v = visibleAlbumsSql(U);
    // The OR with json_each(shared_with) is one pass over the (small) albums table, materialised once per query.
    expect(await plan(`SELECT name FROM albums WHERE name IN ${v.sql}`, ...v.params)).toMatch(/LIST SUBQUERY/);
  });

  it('thumbnail and single-photo access join albums by primary key', async () => {
    const a = photoAccess(U, 'p');
    const p = await plan(`SELECT 1 FROM photos p${a.join} WHERE p.content_hash = ?${a.where}`, 'h', ...a.params);
    expect(p).toMatch(/SEARCH p USING INDEX sqlite_autoindex_photos_\d \(content_hash=\?\)/);
    expect(p).toMatch(/SEARCH va USING PRIMARY KEY \(name=\?\)/);
  });

  it('person name uniqueness check uses the per-owner index', async () => {
    const p = await plan('SELECT id FROM persons WHERE owner_email = ? AND lower(name) = lower(?) AND id != ?', U.email, 'x', '');
    expect(p).toMatch(/idx_persons_owner_name_lower/);
  });

  it('groups and match candidates', async () => {
    const g = await plan(
      `SELECT f.rowid AS rid, f.id, f.embedding FROM faces f JOIN photos ph ON ph.id = f.photo_id JOIN albums a ON a.name = ph.album
       WHERE f.assign_status = 'unassigned' AND ${MATCHABLE_SQL} AND f.rowid > ? AND a.owner_email = ? ORDER BY f.rowid LIMIT 50`,
      0,
      U.email
    );
    expect(g).toMatch(/SEARCH f USING INDEX idx_faces_assign_status \(assign_status=\? AND rowid>\?\)/);
    expect(g).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    expect(g).toMatch(/SEARCH a USING COVERING INDEX idx_albums_owner_email/);
    const s = scopeFor(U, 'ph.album');
    const l = await plan(
      `SELECT p.id, COUNT(f.id) FROM persons p LEFT JOIN faces f ON f.person_id = p.id AND f.assign_status IN ('confirmed', 'auto')
       AND EXISTS (SELECT 1 FROM photos ph WHERE ph.id = f.photo_id${s.sql}) GROUP BY p.id HAVING p.owner_email = ? OR COUNT(f.id) > 0`,
      ...s.params,
      U.email
    );
    expect(l).toMatch(/SEARCH f USING INDEX idx_faces_person_status_created/);
    expect(l).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    const ids = await plan(
      `SELECT f.id FROM json_each(?) j CROSS JOIN faces f ON f.id = j.value JOIN photos ph ON ph.id = f.photo_id JOIN albums a ON a.name = ph.album WHERE f.assign_status = 'unassigned' AND a.owner_email IS NOT NULL`,
      '[]'
    );
    expect(ids).toMatch(/SEARCH f USING INDEX sqlite_autoindex_faces_1 \(id=\?\)/);
    expect(ids).toMatch(/SEARCH a USING PRIMARY KEY \(name=\?\)/);
    const role = await plan(
      `SELECT j.value, va.owner_email FROM json_each(?) j LEFT JOIN faces f ON f.id = j.value LEFT JOIN photos ph ON ph.id = f.photo_id LEFT JOIN albums va ON va.name = ph.album`,
      '[]'
    );
    expect(role).not.toMatch(/SCAN (f|ph|va)\b/);
    const seen = await plan(
      `SELECT 1 FROM faces f JOIN photos ph ON ph.id = f.photo_id JOIN albums va ON va.name = ph.album WHERE f.person_id = ? AND f.assign_status IN ('confirmed','auto') AND (va.owner_email = ? OR EXISTS (SELECT 1 FROM json_each(va.shared_with) WHERE value = ?)) LIMIT 1`,
      'p', U.email, U.email
    );
    expect(seen).toMatch(/SEARCH f USING INDEX idx_faces_person_status_created \(person_id=\? AND assign_status=\?\)/);
    expect(seen).toMatch(/SEARCH va USING PRIMARY KEY/);
    const refs = await plan(
      `SELECT p.id FROM persons p CROSS JOIN faces f ON f.rowid IN (SELECT f2.rowid FROM faces f2 WHERE f2.person_id = p.id AND f2.assign_status = 'confirmed' ORDER BY f2.created_at DESC, f2.rowid DESC LIMIT 30) WHERE p.owner_email = ?`,
      U.email
    );
    expect(refs).toMatch(/SEARCH p USING INDEX idx_persons_owner_name_lower \(owner_email=\?\)/);
  });
});

describe('person label resolution', () => {
  it('the label lookup is a primary key search on person_labels', async () => {
    const p = await plan(
      `SELECT CASE WHEN p.owner_email = ? THEN p.name ELSE (SELECT pl.name FROM person_labels pl WHERE pl.viewer_email = ? AND pl.person_id = p.id) END FROM persons p`,
      U.email,
      U.email
    );
    expect(p).toMatch(/SEARCH pl USING (COVERING )?INDEX sqlite_autoindex_person_labels_1 \(viewer_email=\? AND person_id=\?\)/);
  });
  it('deleting labels by person uses idx_person_labels_person', async () => {
    expect(await plan('DELETE FROM person_labels WHERE person_id = ?', 'x')).toMatch(/idx_person_labels_person/);
  });
  it('the clash check uses the per-viewer name index', async () => {
    const p = await plan('SELECT 1 AS x FROM person_labels WHERE viewer_email = ? AND lower(name) = lower(?) AND person_id != ?', U.email, 'x', '');
    expect(p).toMatch(/idx_person_labels_viewer_name_lower/);
  });
  it('the known-person photo filter uses the partial index', async () => {
    const p = await plan('SELECT photo_id FROM faces WHERE known_id IN (?,?) GROUP BY photo_id HAVING COUNT(DISTINCT known_id) = ?', 'Q1', 'Q2', 2);
    expect(p).toMatch(/idx_faces_known_photo/);
    expect(p).not.toMatch(/SCAN faces/);
  });
  it('the embeddings page query ranges over faces by rowid', async () => {
    const p = await plan('SELECT rowid, id, embedding FROM faces WHERE embedding_model = ? AND rowid > ? AND rowid <= ? AND (? = 1 OR known_id IS NULL) ORDER BY rowid LIMIT ?', 'm', 0, 5000, 0, 100);
    expect(p).toMatch(/SEARCH faces USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(await plan('SELECT max(rowid) AS m FROM faces')).not.toMatch(/SCAN faces/);
    expect(p).not.toMatch(/SCAN faces|TEMP B-TREE/);
  });

  it('known-people list walks idx_faces_known_photo with a photos primary-key lookup', async () => {
    const s = scopeFor(U, 'p.album');
    const k = await plan(`${KNOWN_COUNTS_SQL}${s.sql} GROUP BY f.known_id`, ...s.params);
    expect(k).toMatch(/SEARCH f USING COVERING INDEX idx_faces_known_photo \(known_id>\?\)/);
    expect(k).toMatch(/SEARCH p USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    const n = await plan('SELECT k.id, k.name, k.aliases FROM json_each(?) j JOIN known_people k ON k.id = j.value', '[]');
    expect(n).toMatch(/SEARCH k USING INDEX sqlite_autoindex_known_people_1 \(id=\?\)/);
  });
});
