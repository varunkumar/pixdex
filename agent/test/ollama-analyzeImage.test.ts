import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeImage, parseAnalysisResponse } from '../src/ollama/analyzeImage';
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
});
