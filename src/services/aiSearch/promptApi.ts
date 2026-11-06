import { normalizeKeywords } from './ranking';

export type PromptApiStatus = 'unsupported' | 'available' | 'downloadable' | 'downloading';

export interface Expansion {
  occasion: string;
  keywords: string[];
}

const OUTPUT = [{ type: 'text' as const, languages: ['en'] }];

const SYSTEM_PROMPT = `You turn a request for photos into search keywords for a personal photo library.
Rules:
- Put the occasion or purpose name first in "occasion", and include its alternate names in "keywords" (for example xmas and christmas).
- Then add symbols tied to it (for example diya, rangoli, star, snow).
- Then add colour and light words (for example golden, warm, glow).
- Then add generic subjects that suit the mood (for example flower, sky, lake).
- Use single words or two-word phrases, 10 to 18 keywords in total.
- Never include people, gods or faces.
Reply with JSON only: {"occasion": string, "keywords": string[]}.`;

const EXAMPLE_REQUEST = 'Get me a photo for Xmas wishes to my colleagues';
const EXAMPLE_REPLY = JSON.stringify({
  occasion: 'xmas',
  keywords: [
    'xmas', 'christmas', 'star', 'snow', 'pine', 'lights', 'ornament', 'candle',
    'red', 'green', 'golden', 'warm glow', 'winter', 'bokeh', 'sky', 'tree',
  ],
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    occasion: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' }, minItems: 10, maxItems: 18 },
  },
  required: ['occasion', 'keywords'],
};

export async function getPromptApiStatus(): Promise<PromptApiStatus> {
  if (typeof LanguageModel === 'undefined') return 'unsupported';
  try {
    const a = await LanguageModel.availability({ expectedOutputs: OUTPUT });
    return a === 'unavailable' ? 'unsupported' : a;
  } catch {
    return 'unsupported';
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function fromValue(v: unknown): { occasion: string; list: string[] } | undefined {
  if (Array.isArray(v)) return { occasion: '', list: strings(v) };
  if (v && typeof v === 'object') {
    const o = v as { occasion?: unknown; keywords?: unknown };
    return {
      occasion: typeof o.occasion === 'string' ? o.occasion : '',
      list: strings(o.keywords),
    };
  }
  return undefined;
}

/** Parse a model reply into an occasion plus clean, unique, lowercase keywords. */
export function parseExpansion(raw: string): Expansion {
  const text = raw.trim();
  let parsed = fromValue(tryJson(text));
  if (!parsed) {
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) parsed = fromValue(tryJson(obj[0]));
  }
  if (!parsed) {
    const arr = text.match(/\[[\s\S]*\]/);
    if (arr) parsed = fromValue(tryJson(arr[0]));
  }
  const occasion = parsed ? normalizeKeywords(parsed.occasion)[0] ?? '' : '';
  const keywords = parsed ? normalizeKeywords([occasion, ...parsed.list].join(',')) : [];
  if (keywords.length === 0) throw new Error('The model did not return keywords');
  return { occasion: occasion || keywords[0], keywords };
}

export async function expandRequest(
  request: string,
  onStatus?: (message: string) => void,
): Promise<Expansion> {
  if (typeof LanguageModel === 'undefined') throw new Error('The Prompt API is not available');
  const session = await LanguageModel.create({
    expectedOutputs: OUTPUT,
    initialPrompts: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: EXAMPLE_REQUEST },
      { role: 'assistant', content: EXAMPLE_REPLY },
    ],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        onStatus?.(`Downloading the on-device model: ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
  try {
    let reply: string;
    try {
      reply = await session.prompt(request, { responseConstraint: RESPONSE_SCHEMA });
    } catch {
      reply = await session.prompt(request);
    }
    return parseExpansion(reply);
  } finally {
    session.destroy();
  }
}
