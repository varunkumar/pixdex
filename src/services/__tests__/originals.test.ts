import { describe, expect, it } from 'vitest';
import { getOriginalUrl } from '../originals';
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
  it('returns a Drive view link for google_drive photos, regardless of tunnel config', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'google_drive', driveFileId: 'abc123' };
    expect(getOriginalUrl(photo, { baseUrl: '', token: '' })).toBe('https://drive.google.com/file/d/abc123/view');
  });

  it('returns a token-bearing tunnel URL for local photos when the tunnel is configured', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'local' };
    expect(getOriginalUrl(photo, { baseUrl: 'https://pixdex-originals.example.com', token: 'shh' })).toBe(
      'https://pixdex-originals.example.com/originals/p1?token=shh'
    );
  });

  it('returns null for local photos when the tunnel is not configured', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'local' };
    expect(getOriginalUrl(photo, { baseUrl: '', token: '' })).toBeNull();
  });
});
