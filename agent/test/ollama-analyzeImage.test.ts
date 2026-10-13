import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeImage, buildAnalysisPrompt, parseAnalysisResponse, parseJsonAnalysis } from '../src/ollama/analyzeImage';
import { OllamaClient } from '../src/ollama/client';

const SAMPLE_RESPONSE = `SUBJECTS: leopard, big cat

COLORS: gold, green

PATTERNS: spots

SEASON: winter

ENVIRONMENT: dense forest

TAGS: leopard, big cat, forest, tree

DESCRIPTION: A leopard resting on a tree branch at dusk.`;

describe('parseAnalysisResponse', () => {
  it('parses structured sections into an ImageAnalysisResult', () => {
    const result = parseAnalysisResponse(SAMPLE_RESPONSE);
    expect(result.subjects).toEqual(['leopard', 'big cat']);
    expect(result.tags).toContain('big cat');
    expect(result.season).toBe('winter');
    expect(result.description).toBe('A leopard resting on a tree branch at dusk.');
  });

  it('falls back to defaults for missing sections', () => {
    const result = parseAnalysisResponse('DESCRIPTION: just a photo.');
    expect(result.subjects).toEqual(['Unknown']);
    expect(result.colors).toEqual(['Not specified']);
  });
});

describe('buildAnalysisPrompt', () => {
  it('forbids guessing a location and does not assume India', () => {
    const prompt = buildAnalysisPrompt();
    expect(prompt).toMatch(/do not guess where the photo was taken/i);
    expect(prompt).not.toMatch(/from India/i);
    expect(prompt).not.toMatch(/Known context/);
  });

  it('passes the album as the only known location', () => {
    expect(buildAnalysisPrompt({ album: 'Bandipur' })).toMatch(/album "Bandipur"/);
  });
});

describe('parseJsonAnalysis', () => {
  it('parses a bare or fenced JSON reply', () => {
    const json = JSON.stringify({
      subjects: ['child', 'portrait'],
      colors: ['red'],
      patterns: [],
      season: '',
      environment: 'brick wall',
      tags: ['girl'],
      description: 'A girl.',
    });
    for (const reply of [json, '```json\n' + json + '\n```', 'Here you go: ' + json]) {
      const result = parseJsonAnalysis(reply);
      expect(result?.subjects).toEqual(['child', 'portrait']);
      expect(result?.season).toBeUndefined();
      expect(result?.patterns).toEqual(['None detected']);
      expect(result?.description).toBe('A girl.');
    }
  });

  it('returns null for non-JSON replies', () => {
    expect(parseJsonAnalysis('SUBJECTS: leopard')).toBeNull();
  });
});

describe('parseAnalysisResponse with markdown replies', () => {
  it('handles headings, numbering, bullets and bold markers', () => {
    const result = parseAnalysisResponse(`### 1. SUBJECTS
- **Subject (human):** A young girl
### 2. COLORS
- red
- pink
### 6. TAGS
portrait, child, girl
### 7. DESCRIPTION
A portrait of a girl.`);
    expect(result.tags).toEqual(['portrait', 'child', 'girl']);
    expect(result.description).toBe('A portrait of a girl.');
    expect(result.colors).toEqual(['red pink']);
  });

  it('handles bulleted "- field: value" replies', () => {
    const result = parseAnalysisResponse('- subjects: child, girl\n- season: \n- tags: a, b\n- description: A girl.');
    expect(result.subjects).toEqual(['child', 'girl']);
    expect(result.season).toBeUndefined();
    expect(result.tags).toEqual(['a', 'b']);
  });
});

describe('analyzeImage', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-analyze-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a prompt asking for broader-category tags and parses the reply', async () => {
    const chat = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const client = { chat } as unknown as OllamaClient;

    const result = await analyzeImage(filePath, client);

    expect(result.subjects).toEqual(['leopard', 'big cat']);
    const [messages] = chat.mock.calls[0];
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toMatch(/broader category/i);
    expect(userMessage.images).toHaveLength(1);
  });

  it('keeps thinking on for the image analysis, where reasoning improves the result', async () => {
    const chat = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    await analyzeImage(filePath, { chat } as unknown as OllamaClient);
    expect(chat.mock.calls[0][1]).toEqual({ think: true });
  });

  it('downscales large images before sending them to the model', async () => {
    const bigPath = path.join(dir, 'big.jpg');
    await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg()
      .toFile(bigPath);
    const chat = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const client = { chat } as unknown as OllamaClient;

    await analyzeImage(bigPath, client);

    const [messages] = chat.mock.calls[0];
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');
    const sent = await sharp(Buffer.from(userMessage.images[0], 'base64')).metadata();
    expect(Math.max(sent.width ?? 0, sent.height ?? 0)).toBe(1536);
  });
});
