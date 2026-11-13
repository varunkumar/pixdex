import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderWithProviders';
import SuggestionPanel, { type PanelSection } from '../SuggestionPanel';

const sections: PanelSection[] = [
  { key: 'own', heading: 'Your people', items: [{ key: 'own:a', kind: 'own', label: 'Asha', pick: vi.fn() }] },
  { key: 'known', heading: 'Known', items: [{ key: 'known:k', kind: 'known', label: 'Kay', pick: vi.fn() }] },
  { key: 'album', heading: 'Albums', items: [{ key: 'album:g', kind: 'album', label: 'Goa', pick: vi.fn() }] },
];
const render = (layout: 'list' | 'chips') =>
  renderWithProviders(
    <SuggestionPanel id="s" layout={layout} sections={sections} highlighted={null} optionId={(k) => `s-${k}`} />,
  );
const style = (name: RegExp) => screen.getByRole('option', { name }).getAttribute('style') ?? '';

describe('SuggestionPanel colours', () => {
  it('list rows (no tint behind them) use the ink colours, so they stay readable in dark mode', () => {
    render('list');
    expect(style(/Asha/)).toContain('var(--pixdex-ink-blue)');
    expect(style(/Kay/)).toContain('var(--pixdex-ink-violet)');
    expect(style(/Goa/)).toContain('var(--pixdex-ink-teal)');
  });

  it('chips keep the tint and its matching text colour', () => {
    render('chips');
    expect(style(/Asha/)).toContain('var(--mantine-color-blue-light-color)');
    expect(style(/Kay/)).toContain('var(--mantine-color-violet-light-color)');
  });

  it('index.css defines every ink colour for light and overrides it for dark', () => {
    const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');
    const dark = css.slice(css.indexOf("[data-mantine-color-scheme='dark']"));
    for (const c of ['blue', 'violet', 'teal', 'gray']) {
      expect(css).toContain(`--pixdex-ink-${c}: var(--mantine-color-${c}-light-color)`);
      expect(dark).toContain(`--pixdex-ink-${c}: var(--mantine-color-${c}-3)`);
    }
  });
});

describe('SuggestionPanel scrolling', () => {
  const original = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('scrolls the highlighted option into view', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    const ui = (h: string | null) => (
      <SuggestionPanel id="s" layout="list" sections={sections} highlighted={h} optionId={(k) => `s-${k}`} />
    );
    const first = renderWithProviders(ui(null));
    expect(spy).not.toHaveBeenCalled();
    first.unmount();
    renderWithProviders(ui('album:g'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
    expect(spy.mock.contexts[0]).toBe(screen.getByRole('option', { name: /Goa/ }));
  });

  it('does not throw where scrollIntoView is missing', () => {
    // @ts-expect-error jsdom leaves it undefined
    Element.prototype.scrollIntoView = undefined;
    expect(() =>
      renderWithProviders(
        <SuggestionPanel id="s" layout="list" sections={sections} highlighted="own:a" optionId={(k) => `s-${k}`} />,
      ),
    ).not.toThrow();
  });
});
