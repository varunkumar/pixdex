export interface OmniboxState {
  mode: 'plain' | 'ai';
  q: string;
  kw: string;
  hidePeople: boolean;
  leaveRoom: boolean;
}

export function readOmniboxState(params: URLSearchParams): OmniboxState {
  return {
    mode: params.get('mode') === 'ai' ? 'ai' : 'plain',
    q: params.get('q') ?? '',
    kw: params.get('kw') ?? '',
    hidePeople: params.get('hidePeople') !== '0',
    leaveRoom: params.get('room') !== '0',
  };
}

/** Old AI Search link to /search query string. Legacy `people=0` becomes `hidePeople=0`; any other `people` value is dropped. */
export function mapLegacyAiParams(search: string): string {
  const old = new URLSearchParams(search);
  const out = new URLSearchParams();
  out.set('mode', 'ai');
  const q = old.get('q');
  if (q) out.set('q', q);
  const kw = old.get('kw');
  if (kw) out.set('kw', kw);
  if (old.get('people') === '0') out.set('hidePeople', '0');
  if (old.get('room') === '0') out.set('room', '0');
  return out.toString();
}

export function stripAiParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of ['mode', 'kw', 'hidePeople', 'room']) next.delete(k);
  return next;
}
