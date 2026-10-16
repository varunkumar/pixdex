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
  crop_key: string | null;
}

export interface SerializedFace {
  id: string;
  photoId: string;
  thumbnailUrl: string;
  /** Sharp crop of the face, when the agent uploaded one. */
  cropUrl: string | null;
  bbox: { x: number; y: number; w: number; h: number };
  detScore: number;
  personId: string | null;
  personName: string | null;
  status: 'unassigned' | 'auto' | 'confirmed';
  matchScore: number | null;
}

/** Shared SELECT for face reads. Never selects the embedding. */
export const FACE_SELECT = `SELECT f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
  f.det_score, f.person_id, f.assign_status, f.match_score, f.crop_key,
  p.name AS person_name, ph.content_hash AS content_hash
  FROM faces f
  JOIN photos ph ON ph.id = f.photo_id
  LEFT JOIN persons p ON p.id = f.person_id`;

export function serializeFace(row: FaceRow & { person_name: string | null; content_hash: string }): SerializedFace {
  return {
    id: row.id,
    photoId: row.photo_id,
    thumbnailUrl: `/thumbnails/${row.content_hash}`,
    cropUrl: row.crop_key ? `/faces/${row.id}/crop` : null,
    bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
    detScore: row.det_score,
    personId: row.person_id,
    personName: row.person_name,
    status: row.assign_status,
    matchScore: row.match_score,
  };
}

export type FaceWithJoins = FaceRow & { person_name: string | null; content_hash: string };

/**
 * Set-based statement that confirms every given face for a person (clears the
 * match score) and one that drops that person's rejections of those faces.
 * Two statements regardless of how many faces, to stay inside D1's per-invocation query limit.
 */
export const confirmFacesStmts = (db: D1Database, faceIds: string[], personId: string): D1PreparedStatement[] => {
  const ids = JSON.stringify(faceIds);
  return [
    db
      .prepare(
        "UPDATE faces SET person_id = ?, assign_status = 'confirmed', match_score = NULL WHERE id IN (SELECT value FROM json_each(?))"
      )
      .bind(personId, ids),
    db
      .prepare('DELETE FROM face_rejections WHERE person_id = ? AND face_id IN (SELECT value FROM json_each(?))')
      .bind(personId, ids),
  ];
};

/** Returns the ids from `ids` that have no row in faces, in one query. */
export async function missingFaceIds(db: D1Database, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .prepare('SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT id FROM faces)')
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}
