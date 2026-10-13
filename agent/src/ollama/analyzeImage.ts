import sharp from 'sharp';
import type { OllamaClient } from './client';

export interface ImageAnalysisResult {
  subjects: string[];
  colors: string[];
  patterns: string[];
  season?: string;
  environment?: string;
  description: string;
  tags: string[];
  /** undefined when the model did not say. */
  hasWatermark?: boolean;
}

const ANALYSIS_PROMPT = `Analyze this photo (mostly wildlife, but it may also show people, places or other subjects) and describe it using these fields:
- subjects: the main subjects visible. For wildlife, include both the specific species and its broader category (e.g. "leopard" and "big cat"; "osprey" and "raptor"; "monitor lizard" and "reptile") so both specific and general terms are searchable. For people or other subjects, name what is shown (e.g. "child", "portrait", "jeep").
- colors: dominant colors
- patterns: notable patterns or textures
- season: if apparent from the environment or context (Indian seasons), otherwise an empty string
- environment: detailed description of the habitat or setting
- tags: relevant search keywords (max 15), including both specific and broader-category terms
- description: a detailed, professional description of the photo
- watermark: true if a photographer's watermark, signature or logo is overlaid on the photo, otherwise false

Never mention watermarks, signatures, logos or overlaid text in subjects, tags, environment or description. Describe only the scene itself; the watermark field is the only place that information goes.

Do not guess where the photo was taken: never name a specific park, reserve, city or country unless it is given to you below or is legible in the image (e.g. a sign). Describe the habitat instead (e.g. "dry deciduous forest", "rocky outcrop").

Reply with only a JSON object with exactly these keys (subjects, colors, patterns, tags are arrays of strings; season, environment, description are strings; watermark is true or false). No markdown, no commentary.`;

// Full-resolution camera JPEGs (15MB+) make the vision model call slow enough
// to hit Node's 5 minute fetch header timeout, and the model downsamples
// internally anyway.
const ANALYSIS_MAX_DIMENSION = 1536;
const ANALYSIS_JPEG_QUALITY = 85;

export interface AnalyzeImageContext {
  /** Album or folder name: the only trustworthy source of where the photo was taken. */
  album?: string;
}

export function buildAnalysisPrompt(context: AnalyzeImageContext = {}): string {
  if (!context.album) return ANALYSIS_PROMPT;
  return `${ANALYSIS_PROMPT}\n\nKnown context: this photo belongs to the album "${context.album}". Treat the place named there as the location; do not name any other place.`;
}

export async function analyzeImage(
  imagePath: string,
  client: OllamaClient,
  context: AnalyzeImageContext = {}
): Promise<ImageAnalysisResult> {
  const bytes = await sharp(imagePath)
    .rotate()
    .resize(ANALYSIS_MAX_DIMENSION, ANALYSIS_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: ANALYSIS_JPEG_QUALITY })
    .toBuffer();
  const base64Image = bytes.toString('base64');

  const content = await client.chat([
    {
      role: 'system',
      content:
        'You are a wildlife photography expert tasked with analyzing photos. Provide detailed, accurate information about the wildlife, environment, and photographic elements in each image, and state only what is visible or given to you.',
    },
    { role: 'user', content: buildAnalysisPrompt(context), images: [base64Image] },
  ], { think: true });

  return scrubWatermarkMentions(parseJsonAnalysis(content) ?? parseAnalysisResponse(content));
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (/^(true|yes|y)\b/.test(v)) return true;
  if (/^(false|no|n|none)\b/.test(v)) return false;
  return undefined;
}

const WATERMARK = /watermark/i;

/**
 * The prompt asks the model to report watermarks only through the flag, but if
 * one still leaks into the tags or sentences, strip it (and treat that as
 * evidence of a watermark when the flag was missing).
 */
export function scrubWatermarkMentions(result: ImageAnalysisResult): ImageAnalysisResult {
  let found = false;

  const keep = (items: string[]) =>
    items.filter((item) => {
      const mentions = WATERMARK.test(item);
      found ||= mentions;
      return !mentions;
    });

  const sentences = (text: string) => {
    const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => {
      const mentions = WATERMARK.test(sentence);
      found ||= mentions;
      return !mentions;
    });
    return kept.join(' ').trim();
  };

  const subjects = keep(result.subjects);
  const colors = keep(result.colors);
  const patterns = keep(result.patterns);
  const tags = keep(result.tags);
  const description = sentences(result.description);
  const environment = result.environment ? sentences(result.environment) : result.environment;

  return {
    ...result,
    subjects: subjects.length ? subjects : ['Unknown'],
    colors: colors.length ? colors : ['Not specified'],
    patterns: patterns.length ? patterns : ['None detected'],
    tags: tags.length ? tags : subjects.length ? subjects : ['Unknown'],
    description: description || 'No description available',
    environment: environment || 'Unknown environment',
    hasWatermark: result.hasWatermark ?? (found ? true : undefined),
  };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/** Parses the schema-constrained JSON reply; null when it is not usable JSON. */
export function parseJsonAnalysis(content: string): ImageAnalysisResult | null {
  let data: Record<string, unknown>;
  try {
    // Models sometimes wrap the object in ``` fences or add a sentence around it.
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const subjects = toStringList(data.subjects);
  const description = text(data.description);
  if (subjects.length === 0 && !description) return null;

  return {
    subjects: subjects.length ? subjects : ['Unknown'],
    colors: toStringList(data.colors).length ? toStringList(data.colors) : ['Not specified'],
    patterns: toStringList(data.patterns).length ? toStringList(data.patterns) : ['None detected'],
    season: text(data.season),
    environment: text(data.environment) ?? 'Unknown environment',
    tags: toStringList(data.tags).length ? toStringList(data.tags) : subjects.length ? subjects : ['Unknown'],
    description: description ?? 'No description available',
    hasWatermark: parseBoolean(data.watermark),
  };
}

const SECTION_NAMES = ['subjects', 'colors', 'patterns', 'season', 'environment', 'tags', 'description', 'watermark'];

/**
 * Fallback for replies that are not JSON. Tolerates markdown headings, bullets,
 * bold markers and numbering around section names ("### 1. SUBJECTS",
 * "- **tags:** a, b") with or without a colon.
 */
export function parseAnalysisResponse(content: string): ImageAnalysisResult {
  const fields: Record<string, string[]> = {};
  let current: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .replace(/\*\*|__/g, '')
      .replace(/^[\s#>*\-•]+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim();
    const match = line.match(/^([A-Za-z ]+?)\s*(?::\s*(.*))?$/);
    const name = match?.[1].trim().toLowerCase().replace(/s$/, '');
    const section = SECTION_NAMES.find((n) => n === name || n.replace(/s$/, '') === name);
    const isHeading = section !== undefined;

    if (isHeading && section) {
      current = section;
      fields[current] = fields[current] ?? [];
      if (match?.[2]) fields[current].push(match[2].trim());
    } else if (current && line) {
      fields[current].push(line);
    }
  }

  const join = (name: string) => (fields[name] ?? []).join(' ').trim();
  const list = (name: string) => splitList(join(name));

  const subjects = list('subjects');
  const colors = list('colors');
  const patterns = list('patterns');
  const tags = list('tags');

  return {
    subjects: subjects.length ? subjects : ['Unknown'],
    colors: colors.length ? colors : ['Not specified'],
    patterns: patterns.length ? patterns : ['None detected'],
    season: join('season') || undefined,
    environment: join('environment') || 'Unknown environment',
    tags: tags.length ? tags : subjects.length ? subjects : ['Unknown'],
    description: join('description') || 'No description available',
    hasWatermark: parseBoolean(join('watermark')),
  };
}

function splitList(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
