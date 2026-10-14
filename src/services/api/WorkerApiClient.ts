import type { AlbumsPageResponse, AlbumsResponse, DailyPickResponse, SearchResponse, SerializedPhoto } from '../../types/api';

export interface SearchParams {
  q?: string;
  album?: string;
  sort?: 'date';
  limit?: number;
  offset?: number;
}

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    // Wrapped so fetch is called unbound: invoking window.fetch as a method of
    // this class throws "Illegal invocation" in browsers.
    private fetchFn: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`);
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

  async getAlbumsPage(params: { limit?: number; offset?: number } = {}): Promise<AlbumsPageResponse> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.getJson<AlbumsPageResponse>(`/albums${suffix}`);
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
