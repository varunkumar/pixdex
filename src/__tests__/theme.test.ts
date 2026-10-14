import { describe, expect, it } from 'vitest';
import { BRAND, HEADER_GRADIENT, theme } from '../theme';

describe('theme', () => {
  it('names the product PixdeX', () => {
    expect(BRAND).toBe('PixdeX');
  });

  it('uses the Aurora gradient and primary colour', () => {
    expect(HEADER_GRADIENT).toContain('#0E8F9A');
    expect(HEADER_GRADIENT).toContain('#2563EB');
    expect(HEADER_GRADIENT).toContain('#7C3AED');
    expect(theme.primaryColor).toBe('aurora');
    expect(theme.colors?.aurora).toHaveLength(10);
    expect(theme.colors?.aurora?.[6]).toBe('#0E8F9A');
  });
});
