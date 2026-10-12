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
}

const ANALYSIS_PROMPT = `Analyze this photo (mostly wildlife from India, but it may also show people, places or other subjects) and describe it using these fields:
- subjects: the main subjects visible. For wildlife, include both the specific species and its broader category (e.g. "leopard" and "big cat"; "osprey" and "raptor"; "monitor lizard" and "reptile") so both specific and general terms are searchable. For people or other subjects, name what is shown (e.g. "child", "portrait", "jeep").
- colors: dominant colors
- patterns: notable patterns or textures
- season: if apparent from the environment or context (Indian seasons), otherwise an empty string
- environment: detailed description of the habitat or setting
- tags: relevant search keywords (max 15), including both specific and broader-category terms
- description: a detailed, professional description of the photo

Reply with only a JSON object with exactly these keys (subjects, colors, patterns, tags are arrays of strings; season, environment, description are strings). No markdown, no commentary.`;

// Full-resolution camera JPEGs (15MB+) make the vision model call slow enough
// to hit Node's 5 minute fetch header timeout, and the model downsamples
// internally anyway.
const ANALYSIS_MAX_DIMENSION = 1536;
const ANALYSIS_JPEG_QUALITY = 85;

export async function analyzeImage(imagePath: string, client: OllamaClient): Promise<ImageAnalysisResult> {
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
        'You are a wildlife photography expert tasked with analyzing photos (mostly from India). Provide detailed, accurate information about the wildlife, environment, and photographic elements in each image.',
    },
    { role: 'user', content: ANALYSIS_PROMPT, images: [base64Image] },
  ]);

  return parseJsonAnalysis(content) ?? parseAnalysisResponse(content);
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
  };
}

const SECTION_NAMES = ['subjects', 'colors', 'patterns', 'season', 'environment', 'tags', 'description'];

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
  };
}

function splitList(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
