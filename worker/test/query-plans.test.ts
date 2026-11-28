import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MATCHABLE_SQL } from '../src/people/matching';
import { KNOWN_COUNTS_SQL } from '../src/routes/known';
import { knownFilterSql } from '../src/db/known';
import { speciesFilterSql } from '../src/db/species';
import { photoAccess, scopeFor, visibleAlbumsSql } from '../src/db/visibility';
import { KNOWN_COUNTS_ALBUM_SQL, KNOWN_COVERS_SQL, PEOPLE_COUNTS_SQL, PEOPLE_COVERS_SQL, SPECIES_SQL } from '../src/routes/album-contents';
import { GROUP_CANDIDATES_SQL, MATCH_CANDIDATES_SQL, MATCH_MOVED_SQL, MATCH_UNNAMED_SQL, ignoredFacesSql, autoFacesSql, CONFIRM_AUTO_SQL, REJECT_AUTO_INSERT_SQL, REJECT_AUTO_SQL, REVIEW_QUEUE_SQL } from '../src/routes/people';
import { IGNORE_FACES_SQL, personPhotoFacesSql, RESTORE_FACES_SQL } from '../src/routes/faces';
import { CHOOSE_REFERENCES_SQL, DROP_REFERENCES_SQL } from '../src/people/referenceSelection';
import { pendingSpeciesSql, SPECIES_ROWS_BY_HASH_SQL } from '../src/routes/ingest-species';

import { ON_THIS_DAY_SQL } from '../src/insights/onThisDay';
import { PEOPLE_SQL } from '../src/insights/people';
import { ZOOM_SQL } from '../src/insights/gear';

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

  it("a person's faces for a page of photos walk the photo index, never all of the person's faces", async () => {
    const s = scopeFor(U, 'ph.album');
    const p = await plan(personPhotoFacesSql(s.sql), U.email, U.email, '[]', 'p1', ...s.params);
    expect(p).toMatch(/SEARCH f USING INDEX idx_faces_photo_id \(photo_id=\?\)/);
    expect(p).not.toMatch(/idx_faces_person_status_created|SCAN f\b|SCAN ph\b/);
  });

  it('person name uniqueness check uses the per-owner index', async () => {
    const p = await plan('SELECT id FROM persons WHERE owner_email = ? AND lower(name) = lower(?) AND id != ?', U.email, 'x', '');
    expect(p).toMatch(/idx_persons_owner_name_lower/);
  });

  it('groups and match candidates', async () => {
    const g = await plan(GROUP_CANDIDATES_SQL, 0, U.email);
    expect(g).toMatch(/SEARCH f USING INDEX idx_faces_open_status \(assign_status=\? AND rowid>\?\)/);
    expect(g).not.toMatch(/TEMP B-TREE/);
    expect(g).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    expect(g).toMatch(/SEARCH a USING (PRIMARY KEY \(name=\?\)|COVERING INDEX idx_albums_owner_email \(owner_email=\? AND name=\?\))/);
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

describe('match candidates page', () => {
  it('walks faces in rowid order and stops at the page size, with no sort of all candidates', async () => {
    const p = await plan(MATCH_CANDIDATES_SQL, 0, U.email, 'p', 'p');
    expect(p).toMatch(/SEARCH f USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(p).not.toMatch(/TEMP B-TREE|MULTI-INDEX|idx_faces_open_status/);
    expect(p).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    // One key lookup either way: by primary key or by the owner index with the name.
    expect(p).toMatch(/SEARCH a USING (PRIMARY KEY \(name=\?\)|COVERING INDEX idx_albums_owner_email \(owner_email=\? AND name=\?\))/);
  });
});

describe('narrow match candidates pages', () => {
  it('seeks the not-ignored index for unnamed faces, in rowid order', async () => {
    const p = await plan(MATCH_UNNAMED_SQL, 0, U.email, 'p');
    expect(p).toMatch(/SEARCH f USING INDEX idx_faces_open_status \(assign_status=\? AND rowid>\?\)/);
    expect(p).not.toMatch(/TEMP B-TREE|SCAN f\b|idx_faces_assign_status/);
  });

  it('reads the previous people\'s auto faces through a covering index, never walking all faces', async () => {
    const p = await plan(MATCH_MOVED_SQL, 0, U.email, 'p', '["q"]');
    expect(p).toMatch(/SEARCH p USING COVERING INDEX idx_faces_person_status_created \(person_id=\? AND assign_status=\?/);
    expect(p).toMatch(/SEARCH f USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(p).not.toMatch(/SCAN f\b|idx_faces_assign_status/);
  });
});

describe('ignored faces list', () => {
  it.each([false, true])('walks the ignored index newest first with no sort (after cursor: %s)', async (after) => {
    const p = await plan(ignoredFacesSql(after), U.email, U.email, ...(after ? ['t', 1] : []), U.email);
    expect(p).toMatch(/(SEARCH|SCAN) f USING INDEX idx_faces_ignored/);
    expect(p).not.toMatch(/TEMP B-TREE/);
    expect(p).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
  });
});

describe('review of auto matches', () => {
  it.each([false, true])('lists through the person index, reading other tables by key (after cursor: %s)', async (after) => {
    const p = await plan(autoFacesSql(after), U.email, U.email, 'p', U.email, ...(after ? [0.5, 1] : []));
    expect(p).toMatch(/SEARCH f2 USING INDEX idx_faces_person_status_created \(person_id=\? AND assign_status=\?\)/);
    expect(p).toMatch(/SEARCH f USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(p).not.toMatch(/SCAN (f|f2|ph|a)\b/);
  });

  it.each([
    ['confirm', CONFIRM_AUTO_SQL, ['[]', 'p', U.email]],
    ['record rejections', REJECT_AUTO_INSERT_SQL, ['p', '[]', 'p', U.email]],
    ['reject', REJECT_AUTO_SQL, ['[]', 'p', U.email]],
  ])('%s reads faces by primary key only', async (_label, sql, params) => {
    const p = await plan(sql, ...params);
    expect(p).toMatch(/SEARCH faces USING (COVERING )?INDEX sqlite_autoindex_faces_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN (faces|ph|a)\b/);
  });
});

describe('review queue', () => {
  it("walks only the caller's people and their auto faces", async () => {
    const p = await plan(REVIEW_QUEUE_SQL, U.email);
    expect(p).toMatch(/SEARCH p USING (COVERING )?INDEX idx_persons_owner_name_lower \(owner_email=\?\)/);
    expect(p).toMatch(/SEARCH f USING INDEX idx_faces_person_status_created \(person_id=\? AND assign_status=\?\)/);
    expect(p).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN (p|f|ph|a)\b/);
  });
});

describe('reference selection', () => {
  it('walks only the affected people', async () => {
    const p = await plan(CHOOSE_REFERENCES_SQL, '["p"]', '["f"]');
    expect(p).toMatch(/SEARCH f USING INDEX idx_faces_person_status_created \(person_id=\? AND assign_status=\?\)/);
    expect(p).toMatch(/SEARCH person_references USING (COVERING )?INDEX idx_person_references_face \(face_id=\?\)/);
    expect(p).toMatch(/SEARCH ph USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN (f|ph|person_references)\b/);
  });

  it('drops rows of the affected people only', async () => {
    const p = await plan(DROP_REFERENCES_SQL, '["p"]', '["f"]', '[]');
    expect(p).toMatch(/SEARCH person_references USING (PRIMARY KEY|COVERING INDEX \S+) \(person_id=\?\)/);
    expect(p).not.toMatch(/SCAN person_references\b/);
  });
});

describe('ignore and restore', () => {
  it.each([
    ['ignore', IGNORE_FACES_SQL, ['t', '[]']],
    ['restore', RESTORE_FACES_SQL, ['[]']],
  ])('%s updates faces by primary key only', async (_label, sql, params) => {
    const p = await plan(sql, ...params);
    expect(p).toMatch(/SEARCH faces USING (COVERING )?INDEX sqlite_autoindex_faces_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN faces/);
  });

  it('rescan statements stay on idx_faces_photo_id', async () => {
    for (const sql of [
      "SELECT id FROM faces WHERE photo_id = ? AND (+assign_status = 'confirmed' OR +ignored_at IS NOT NULL)",
      "DELETE FROM faces WHERE photo_id = ? AND +assign_status IN ('unassigned', 'auto') AND +ignored_at IS NULL",
    ]) {
      expect(await plan(sql, 'p')).toMatch(/SEARCH faces USING INDEX idx_faces_photo_id \(photo_id=\?\)/);
    }
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
  it('the species filter with an album runs its json_each check only on that album rows', async () => {
    const f = speciesFilterSql('Elephas maximus');
    const s = scopeFor(U, 'photos.album');
    const p = await plan(
      `SELECT photos.* FROM photos WHERE 1=1 AND album = ?${s.sql}${f.sql} ORDER BY last_indexed DESC LIMIT ? OFFSET ?`,
      'A',
      ...s.params,
      ...f.params,
      20,
      0
    );
    expect(p).toMatch(/SEARCH photos USING INDEX idx_photos_album \(album=\?\)/);
    expect(p).not.toMatch(/SCAN photos/);
  });
  it('the known-person photo filter uses the partial index', async () => {
    const p = await plan('SELECT photo_id FROM faces INDEXED BY idx_faces_known_shown WHERE known_id IS NOT NULL AND known_id IN (?,?) AND ignored_at IS NULL GROUP BY photo_id HAVING COUNT(DISTINCT known_id) = ?', 'Q1', 'Q2', 2);
    expect(p).toMatch(/idx_faces_known_shown/);
    expect(p).not.toMatch(/SCAN faces/);
  });
  it('the real known filter, combined with people and scope, is an indexed lookup', async () => {
    const k = knownFilterSql(['Q1', 'Q2']);
    const s = scopeFor(U, 'photos.album');
    const p = await plan(
      `SELECT photos.* FROM photos WHERE 1=1${s.sql} AND photos.id IN (SELECT photo_id FROM faces WHERE person_id IN (?,?) AND assign_status IN ('auto','confirmed') GROUP BY photo_id HAVING COUNT(DISTINCT person_id) = ?)${k.sql} ORDER BY last_indexed DESC LIMIT ? OFFSET ?`,
      ...s.params,
      'p1',
      'p2',
      2,
      ...k.params,
      20,
      0
    );
    expect(p).toMatch(/SEARCH faces USING (COVERING )?INDEX idx_faces_known_shown \(known_id=\?\)/);
    expect(p).toMatch(/SEARCH faces USING (COVERING )?INDEX idx_faces_person_status_created/);
    expect(p).not.toMatch(/SCAN faces/);
  });

  it('the embeddings page query ranges over faces by rowid', async () => {
    const p = await plan('SELECT rowid, id, embedding FROM faces WHERE embedding_model = ? AND rowid > ? AND rowid <= ? AND (? = 1 OR known_id IS NULL) ORDER BY rowid LIMIT ?', 'm', 0, 5000, 0, 100);
    expect(p).toMatch(/SEARCH faces USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(await plan('SELECT max(rowid) AS m FROM faces')).not.toMatch(/SCAN faces/);
    expect(p).not.toMatch(/SCAN faces|TEMP B-TREE/);
  });

  it('known-people list walks idx_faces_known_shown with a photos primary-key lookup', async () => {
    const s = scopeFor(U, 'p.album');
    const k = await plan(`${KNOWN_COUNTS_SQL}${s.sql} GROUP BY f.known_id`, ...s.params);
    expect(k).toMatch(/SEARCH f USING COVERING INDEX idx_faces_known_shown \(known_id>\?\)/);
    expect(k).toMatch(/SEARCH p USING INDEX sqlite_autoindex_photos_1 \(id=\?\)/);
    const n = await plan('SELECT k.id, k.name, k.aliases FROM json_each(?) j JOIN known_people k ON k.id = j.value', '[]');
    expect(n).toMatch(/SEARCH k USING INDEX sqlite_autoindex_known_people_1 \(id=\?\)/);
  });

  it('species: rows come from the unique content_hash index and pending pages walk a rowid range', async () => {
    const byHash = await plan(SPECIES_ROWS_BY_HASH_SQL, '[]');
    expect(byHash).toMatch(/SEARCH photos USING (COVERING )?INDEX sqlite_autoindex_photos_\d \(content_hash=\?\)/);
    const pending = await plan(pendingSpeciesSql(), 'bioclip-2', 0, 100);
    expect(pending).toMatch(/SEARCH photos USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(pending).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('album contents start from idx_photos_album and probe faces by idx_faces_photo_id', async () => {
    const sc = scopeFor(U, 'ph.album');
    const queries: [string, string, unknown[]][] = [
      ['people counts', PEOPLE_COUNTS_SQL(sc.sql), [U.email, U.email, U.email, 'Kanha', ...sc.params]],
      ['known counts', KNOWN_COUNTS_ALBUM_SQL(sc.sql), ['Kanha', ...sc.params]],
      ['people covers', PEOPLE_COVERS_SQL(sc.sql), [U.email, U.email, 'Kanha', ...sc.params]],
      ['known covers', KNOWN_COVERS_SQL(sc.sql), [U.email, U.email, 'Kanha', ...sc.params]],
    ];
    for (const [label, sql, params] of queries) {
      const p = await plan(sql, ...params);
      expect(p, label).toMatch(/SEARCH ph USING (COVERING )?INDEX idx_photos_album(_cover)? \(album=\?\)/);
      expect(p, label).toMatch(/SEARCH f USING INDEX idx_faces_photo_id \(photo_id=\?\)/);
      expect(p, label).not.toMatch(/SCAN (ph|photos|f|faces)\b/);
    }
    const sp = await plan(SPECIES_SQL(sc.sql), 'Kanha', ...sc.params);
    expect(sp).toMatch(/SEARCH ph USING (COVERING )?INDEX idx_photos_album(_cover)? \(album=\?\)/);
    expect(sp).not.toMatch(/SCAN (ph|photos)\b/);
  });
});

describe('insight query plans', () => {
  it("On this day searches each of the caller's albums by date, never all photos of a date", async () => {
    const p = await plan(ON_THIS_DAY_SQL, '[]', U.email);
    expect(p).toMatch(/SEARCH a USING (PRIMARY KEY|COVERING INDEX idx_albums_owner_email \(owner_email=\?\))/);
    expect(p).toMatch(/SEARCH photos USING (COVERING )?INDEX idx_photos_album(_cover)? \(album=\? AND date_time>\? AND date_time<\?\)/);
    expect(p).not.toMatch(/idx_photos_date_time|SCAN (a|albums|photos)\b/);
  });

  it("the zoom bins read the caller's albums through the album index, never the whole photos table", async () => {
    const p = await plan(ZOOM_SQL, 150, 600, U.email, 'Lens');
    expect(p).toMatch(/SEARCH photos USING (COVERING )?INDEX idx_photos_album(_cover)? \(album=\?\)/);
    expect(p).not.toMatch(/SCAN (p|photos)\b/);
  });

  it("people start from the caller's persons and never scan faces or photos", async () => {
    const p = await plan(PEOPLE_SQL, '2026-11-28', U.email, U.email, '2026-11-28');
    expect(p).toMatch(/SEARCH f USING (COVERING )?INDEX idx_faces_person\w* \(person_id=\?/);
    expect(p).toMatch(/SEARCH ph USING (COVERING )?INDEX sqlite_autoindex_photos_\d \(id=\?\)/);
    expect(p).not.toMatch(/SCAN (f|ph|faces|photos)\b/);
  });
});

// Keep last: it gathers table statistics.
describe('ignored-face indexes leave the older queries alone, with or without table statistics', () => {
  const covers = `SELECT * FROM (SELECT ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.det_score DESC, f.id) AS rn, f.id
    FROM faces f JOIN photos ph ON ph.id = f.photo_id WHERE f.assign_status IN ('confirmed', 'auto') AND f.person_id IS NOT NULL) WHERE rn = 1`;

  it('the people cover query still starts from idx_faces_assign_status', async () => {
    expect(await plan(covers)).toMatch(/SEARCH f USING INDEX idx_faces_assign_status \(assign_status=\?\)/);
  });

  it('the groups and known-person plans hold after ANALYZE', async () => {
    await env.DB.prepare('ANALYZE').run();
    try {
      expect(await plan(GROUP_CANDIDATES_SQL, 0, U.email)).toMatch(/SEARCH f USING INDEX idx_faces_open_status \(assign_status=\? AND rowid>\?\)/);
      const s = scopeFor(U, 'p.album');
      expect(await plan(`${KNOWN_COUNTS_SQL}${s.sql} GROUP BY f.known_id`, ...s.params)).toMatch(/f USING COVERING INDEX idx_faces_known_shown/);
    } finally {
      await env.DB.prepare('DELETE FROM sqlite_stat1').run();
      await env.DB.prepare('ANALYZE sqlite_schema').run(); // drop the cached statistics
    }
  });
});
