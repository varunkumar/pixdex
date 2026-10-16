import type {
  AlbumsPageResponse,
  AlbumsResponse,
  DailyPickResponse,
  FaceGroup,
  MatchResponse,
  PersonSummary,
  PhotoReviewPatch,
  SearchResponse,
  SerializedFace,
  SerializedPhoto,
} from '../../types/api';

export type PhotoSort = 'date' | 'name' | 'rating';
export type AlbumSort = 'date' | 'name' | 'count' | 'rating';

export interface SearchParams {
  q?: string;
  album?: string;
  people?: string[];
  sort?: PhotoSort;
  limit?: number;
  offset?: number;
}

// Safety valve for matchPersonAll: 150 pages of 200 faces.
const MATCH_ALL_MAX_PAGES = 150;

const RELOAD_KEY = 'pixdex:session-reload-at';
const RELOAD_COOLDOWN_MS = 30_000;

// Reload at most once per cooldown so a genuinely dead session cannot loop.
function reloadOncePerWindow(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    // Wrapped so fetch is called unbound: invoking window.fetch as a method of
    // this class throws "Illegal invocation" in browsers.
    private fetchFn: typeof fetch = (...args) => fetch(...args),
    // Called when Access wants the browser to re-authenticate. Returns whether it
    // started a reload. A full navigation can follow Access's cross-origin hops
    // (usually silently, with no sign-in prompt) where fetch cannot.
    private reloadForSession: () => boolean = reloadOncePerWindow
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      // Look at redirects before following them: Cloudflare Access answers an expired
      // sign-in with a cross-origin redirect, which fetch can only report as the
      // unhelpful "Failed to fetch".
      response = await this.fetchFn(url, { redirect: 'manual' });
    } catch (err) {
      throw new Error(`Request to ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
    }
    if (response.type === 'opaqueredirect') {
      // Access also redirects live sessions in-origin to refresh them. Follow it: only a
      // redirect that cannot be followed (the cross-origin login page) is an expired session.
      try {
        response = await this.fetchFn(url);
      } catch {
        this.reloadForSession();
        throw new Error('Your session has expired. Reload the page to sign in again.');
      }
    }
    if (!response.ok) {
      throw new Error(`Request to ${path} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async search(params: SearchParams): Promise<SerializedPhoto[]> {
    return (await this.searchPage(params)).results;
  }

  async searchPage(params: SearchParams): Promise<SearchResponse> {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.album) query.set('album', params.album);
    if (params.people?.length) query.set('people', params.people.join(','));
    if (params.sort) query.set('sort', params.sort);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.getJson<SearchResponse>(`/search${suffix}`);
  }

  /** Album names only, for dropdowns. */
  async getAlbums(): Promise<string[]> {
    const { albums } = await this.getJson<AlbumsResponse>('/albums?names=1');
    return albums;
  }

  async getAlbumsPage(
    params: { limit?: number; offset?: number; sort?: AlbumSort; name?: string } = {}
  ): Promise<AlbumsPageResponse> {
    // A limit is always sent: the worker returns the rich shape only when asked for a page.
    const query = new URLSearchParams({ limit: String(params.limit ?? 12) });
    if (params.offset != null) query.set('offset', String(params.offset));
    if (params.sort) query.set('sort', params.sort);
    if (params.name) query.set('name', params.name);
    return this.getJson<AlbumsPageResponse>(`/albums?${query.toString()}`);
  }

  async setAlbumCover(album: string, photoId: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/albums/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ album, photoId }),
      });
    } catch (err) {
      throw new Error(`Could not set cover: ${err instanceof Error ? err.message : 'network error'}`);
    }
    if (!response.ok) throw new Error(`Could not set cover: ${response.status}`);
  }

  private async sendJson(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Could not save: ${err instanceof Error ? err.message : 'network error'}`);
    }
    if (!response.ok) throw new Error(`Could not save: ${response.status}`);
    return response;
  }

  async updatePhoto(id: string, patch: PhotoReviewPatch): Promise<SerializedPhoto> {
    const response = await this.sendJson('PATCH', `/photos/${encodeURIComponent(id)}`, patch);
    return (await response.json()) as SerializedPhoto;
  }

  async getPeople(): Promise<PersonSummary[]> {
    return (await this.getJson<{ people: PersonSummary[] }>('/people')).people;
  }

  async getFaceGroups(cursor?: string): Promise<{ groups: FaceGroup[]; scanned: number; nextCursor: string | null }> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.getJson(`/people/groups${suffix}`);
  }

  async getPhotoFaces(photoId: string): Promise<SerializedFace[]> {
    return (await this.getJson<{ faces: SerializedFace[] }>(`/photos/${encodeURIComponent(photoId)}/faces`)).faces;
  }

  async createPerson(name: string, faceIds?: string[]): Promise<{ id: string; name: string }> {
    const response = await this.sendJson('POST', '/people', { name, faceIds });
    return (await response.json()) as { id: string; name: string };
  }

  async renamePerson(id: string, name: string): Promise<void> {
    await this.sendJson('PATCH', `/people/${encodeURIComponent(id)}`, { name });
  }

  async deletePerson(id: string): Promise<void> {
    await this.sendJson('DELETE', `/people/${encodeURIComponent(id)}`);
  }

  async assignFaces(personId: string, faceIds: string[]): Promise<void> {
    await this.sendJson('POST', `/people/${encodeURIComponent(personId)}/faces`, { faceIds });
  }

  async assignFace(faceId: string, personId: string): Promise<SerializedFace> {
    const response = await this.sendJson('POST', `/faces/${encodeURIComponent(faceId)}/assign`, { personId });
    return (await response.json()) as SerializedFace;
  }

  async rejectFace(faceId: string, personId: string): Promise<SerializedFace> {
    const response = await this.sendJson('POST', `/faces/${encodeURIComponent(faceId)}/reject`, { personId });
    return (await response.json()) as SerializedFace;
  }

  async unassignFace(faceId: string): Promise<SerializedFace> {
    const response = await this.sendJson('POST', `/faces/${encodeURIComponent(faceId)}/unassign`);
    return (await response.json()) as SerializedFace;
  }

  async matchPerson(personId: string, opts: { apply?: boolean; cursor?: string } = {}): Promise<MatchResponse> {
    const response = await this.sendJson('POST', `/people/${encodeURIComponent(personId)}/match`, opts);
    return (await response.json()) as MatchResponse;
  }

  /** Applies auto matches page by page until the worker reports no more pages. */
  async matchPersonAll(
    personId: string,
    onPage?: (scanned: number, matched: number) => void
  ): Promise<{ matched: number; truncated: boolean }> {
    let cursor: string | undefined;
    let scanned = 0;
    let matched = 0;
    let truncated = false;
    for (let page = 0; page < MATCH_ALL_MAX_PAGES; page++) {
      const res = await this.matchPerson(personId, cursor ? { apply: true, cursor } : { apply: true });
      scanned += res.scanned;
      matched += res.auto.length;
      onPage?.(scanned, matched);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
      if (page === MATCH_ALL_MAX_PAGES - 1) truncated = true;
    }
    return { matched, truncated };
  }

  async getPhoto(id: string): Promise<SerializedPhoto> {
    return this.getJson<SerializedPhoto>(`/photos/${id}`);
  }

  async getDailyPick(): Promise<DailyPickResponse> {
    return this.getJson<DailyPickResponse>('/daily-pick');
  }

  thumbnailUrl(photo: Pick<SerializedPhoto, 'thumbnailUrl'>): string {
    if (!photo.thumbnailUrl) return '';
    // Same-origin proxy URL: the Pages Function adds the read token server-side.
    return `${this.baseUrl}${photo.thumbnailUrl}`;
  }
}

// Same-origin read proxy (functions/api/[[path]].ts); holds the read token server-side.
export const workerApiClient = new WorkerApiClient('/api');
