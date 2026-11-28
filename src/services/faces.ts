import type { SerializedFace, SerializedPhoto } from '../types/api';
import { photoCaption } from './text';

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

export interface FaceItem {
  face: SerializedFace;
  photo: SerializedPhoto;
  /** The photo's caption, numbered when the photo has more than one face here, so each control has its own name. */
  label: string;
}

/** This person's confirmed and auto faces, in photo order, then left to right. */
export function faceItems(faces: SerializedFace[], photos: SerializedPhoto[], personId: string): FaceItem[] {
  return photos.flatMap((photo) => {
    const mine = faces
      .filter((f) => f.photoId === photo.id && f.personId === personId && f.status !== 'unassigned')
      .sort((a, b) => a.bbox.x - b.bbox.x || a.id.localeCompare(b.id));
    const caption = photoCaption(photo);
    return mine.map((face, i) => ({ face, photo, label: mine.length > 1 ? `${caption}, face ${i + 1}` : caption }));
  });
}
