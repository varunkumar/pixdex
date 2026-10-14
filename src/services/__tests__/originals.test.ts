import { describe, expect, it } from 'vitest';
import { getOriginalImageUrl, getOriginalUrl } from '../originals';
import type { SerializedPhoto } from '../../types/api';

const basePhoto: SerializedPhoto = {
  id: 'p1',
  path: null,
  driveFileId: null,
  dateTime: null,
  width: null,
  height: null,
  format: null,
  fileSize: null,
  subjects: [],
  colors: [],
  patterns: [],
  tags: [],
  season: null,
  environment: null,
  album: null,
  suggestedHashtags: [],
  instagramSuggested: null,
};

describe('getOriginalUrl', () => {
  it('returns a Drive view link for google_drive photos', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'google_drive', driveFileId: 'abc123' };
    expect(getOriginalUrl(photo)).toBe('https://drive.google.com/file/d/abc123/view');
  });

  it('returns the same-origin proxy URL (no token) for local photos', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'local' };
    expect(getOriginalUrl(photo)).toBe('/api/originals/p1');
  });

  it('returns null when the photo has no original to link to', () => {
    expect(getOriginalUrl({ ...basePhoto, source: 'google_drive', driveFileId: null })).toBeNull();
  });
});

describe('getOriginalImageUrl', () => {
  it('returns the proxied image URL for local photos', () => {
    expect(getOriginalImageUrl({ ...basePhoto, id: 'a b', source: 'local' })).toBe('/api/originals/a%20b');
  });

  it('returns null for Drive photos, which only have a viewer page', () => {
    expect(getOriginalImageUrl({ ...basePhoto, source: 'google_drive', driveFileId: 'x' })).toBeNull();
  });
});
