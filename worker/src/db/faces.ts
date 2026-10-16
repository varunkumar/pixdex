export interface FaceRow {
  id: string;
  photo_id: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  det_score: number;
  person_id: string | null;
  assign_status: 'unassigned' | 'auto' | 'confirmed';
  match_score: number | null;
}

export interface SerializedFace {
  id: string;
  photoId: string;
  thumbnailUrl: string;
  bbox: { x: number; y: number; w: number; h: number };
  detScore: number;
  personId: string | null;
  personName: string | null;
  status: 'unassigned' | 'auto' | 'confirmed';
  matchScore: number | null;
}

/** Shared SELECT for face reads. Never selects the embedding. */
export const FACE_SELECT = `SELECT f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
  f.det_score, f.person_id, f.assign_status, f.match_score,
  p.name AS person_name, ph.content_hash AS content_hash
  FROM faces f
  JOIN photos ph ON ph.id = f.photo_id
  LEFT JOIN persons p ON p.id = f.person_id`;

export function serializeFace(row: FaceRow & { person_name: string | null; content_hash: string }): SerializedFace {
  return {
    id: row.id,
    photoId: row.photo_id,
    thumbnailUrl: `/thumbnails/${row.content_hash}`,
    bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
    detScore: row.det_score,
    personId: row.person_id,
    personName: row.person_name,
    status: row.assign_status,
    matchScore: row.match_score,
  };
}

export type FaceWithJoins = FaceRow & { person_name: string | null; content_hash: string };

/** Statement that confirms one face for a person (clears the match score). */
export const confirmFaceStmt = (db: D1Database, faceId: string, personId: string) =>
  db
    .prepare("UPDATE faces SET person_id = ?, assign_status = 'confirmed', match_score = NULL WHERE id = ?")
    .bind(personId, faceId);

/** Returns the ids from `ids` that have no row in faces (chunked for D1's bound-parameter limit). */
export async function missingFaceIds(db: D1Database, ids: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await db
      .prepare(`SELECT id FROM faces WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of rows.results) found.add(r.id);
  }
  return ids.filter((id) => !found.has(id));
}
