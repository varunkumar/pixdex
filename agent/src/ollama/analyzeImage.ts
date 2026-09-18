import fs from 'node:fs/promises';
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

const ANALYSIS_PROMPT = `Analyze this wildlife photo and provide the following information in a structured format:
1. SUBJECTS: List all animals/wildlife subjects visible in the image. For each specific species, also include its broader category (e.g. "leopard" and "big cat"; "osprey" and "raptor"; "monitor lizard" and "reptile") so both the specific and general terms are searchable.
2. COLORS: List dominant colors in the image
3. PATTERNS: Describe any notable patterns or textures
4. SEASON: If apparent from the environment or context. Indian seasons.
5. ENVIRONMENT: Detailed description of the habitat/setting
6. TAGS: Relevant keywords for searching (max 15), including both specific and broader-category terms
7. DESCRIPTION: A detailed, professional description of the photo

Format each section clearly with headings.`;

export async function analyzeImage(imagePath: string, client: OllamaClient): Promise<ImageAnalysisResult> {
  const bytes = await fs.readFile(imagePath);
  const base64Image = bytes.toString('base64');

  const content = await client.chat([
    {
      role: 'system',
      content:
        'You are a wildlife photography expert tasked with analyzing photos (mostly from India). Provide detailed, accurate information about the wildlife, environment, and photographic elements in each image.',
    },
    { role: 'user', content: ANALYSIS_PROMPT, images: [base64Image] },
  ]);

  return parseAnalysisResponse(content);
}

export function parseAnalysisResponse(content: string): ImageAnalysisResult {
  const sections = content.split(/\n\s*\n/);
  const result: ImageAnalysisResult = {
    subjects: [],
    colors: [],
    patterns: [],
    season: undefined,
    environment: undefined,
    description: '',
    tags: [],
  };

  for (const section of sections) {
    const lines = section.split('\n').map((s) => s.trim());
    const firstLine = lines[0];

    // Extract heading and body from first line (format: "HEADING: body")
    const match = firstLine.match(/^([A-Z\s]+?):\s*(.*)/);
    if (!match) continue;

    const heading = match[1] + ':';
    let body = match[2]; // Body after colon on same line
    if (lines.length > 1) {
      body = (body ? body + ' ' : '') + lines.slice(1).join(' ');
    }
    body = body.trim();

    if (/SUBJECTS?:/i.test(heading)) result.subjects = splitList(body);
    else if (/COLORS?:/i.test(heading)) result.colors = splitList(body);
    else if (/PATTERNS?:/i.test(heading)) result.patterns = splitList(body);
    else if (/SEASON:/i.test(heading)) result.season = body || undefined;
    else if (/ENVIRONMENT:/i.test(heading)) result.environment = body || undefined;
    else if (/TAGS?:/i.test(heading)) result.tags = splitList(body);
    else if (/DESCRIPTION:/i.test(heading)) result.description = body;
  }

  result.subjects = result.subjects.length ? result.subjects : ['Unknown'];
  result.colors = result.colors.length ? result.colors : ['Not specified'];
  result.patterns = result.patterns.length ? result.patterns : ['None detected'];
  result.tags = result.tags.length ? result.tags : [...result.subjects];
  result.description = result.description || 'No description available';
  result.environment = result.environment || 'Unknown environment';

  return result;
}

function splitList(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
