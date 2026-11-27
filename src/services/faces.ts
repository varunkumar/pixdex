import type { SerializedFace } from '../types/api';

// Mirrors MIN_DET_SCORE and MIN_FACE_SIDE in worker/src/people/matching.ts: smaller or less certain faces never
// appear in the People page's unnamed groups and are never matched to anyone.
const MIN_DET_SCORE = 0.7;
const MIN_FACE_SIDE = 0.05;

const isMatchable = (f: SerializedFace) => f.detScore >= MIN_DET_SCORE && f.bbox.w >= MIN_FACE_SIDE && f.bbox.h >= MIN_FACE_SIDE;

/** Which of the photo's hidden face sections are open. */
export interface OpenFaceSections {
  other: boolean;
  ignored: boolean;
}
export const CLOSED_SECTIONS: OpenFaceSections = { other: false, ignored: false };

/**
 * Splits a photo's faces into the ones listed by default, the album owner's unnamed faces that People leaves out
 * ("other") and the ignored ones. `shown` is the display order, used for both the People card and the boxes on the
 * photo, so their numbers match. Only the album owner has faces hidden; anyone else sees every face.
 */
export function splitFaces(faces: SerializedFace[], canEdit: boolean, open: OpenFaceSections) {
  const listed: SerializedFace[] = [];
  const other: SerializedFace[] = [];
  const ignored: SerializedFace[] = [];
  for (const f of faces) {
    if (!canEdit) listed.push(f);
    else if (f.ignored) ignored.push(f);
    else if (f.status === 'unassigned' && !isMatchable(f)) other.push(f);
    else listed.push(f);
  }
  const shown = [...listed, ...(open.other ? other : []), ...(open.ignored ? ignored : [])];
  return { other, ignored, shown };
}
