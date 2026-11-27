import { useEffect, type MouseEvent } from 'react';
import { Box, Group, Paper, Stack, Text, VisuallyHidden } from '@mantine/core';
import { MdVerified } from 'react-icons/md';
import type { CandidateKind } from '../../services/omnibox/matcher';
import { inkColor, kindColor } from '../chipStyle';

export interface PanelItem {
  key: string;
  kind: CandidateKind | 'both' | 'more';
  label: string;
  /** Accessible name, where the visible label alone says too little. */
  ariaLabel?: string;
  pick: () => void;
}

export interface PanelSection {
  key: string;
  /** Visible group heading (list layout) or an accessible name only (chips layout). */
  heading: string;
  items: PanelItem[];
}

export const OWN_GROUP = 'Your people';
export const KNOWN_GROUP = 'Known personalities in your photos';
export const ALBUM_GROUP = 'Albums';

/** Label text with the non-colour signals: the known icon and hidden "(known personality)" or "(album)". */
export function ChipLabel({ kind, label }: { kind: PanelItem['kind']; label: string }) {
  return (
    <>
      {kind === 'known' && <MdVerified aria-hidden size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />}
      {label}
      {kind === 'known' && <VisuallyHidden> (known personality)</VisuallyHidden>}
      {kind === 'album' && <VisuallyHidden> (album)</VisuallyHidden>}
    </>
  );
}

interface Props {
  id: string;
  layout: 'list' | 'chips';
  sections: PanelSection[];
  highlighted: string | null;
  optionId: (key: string) => string;
}

/**
 * The listbox under the bar. "list" is the full grouped list for an empty input (a dropdown); "chips" is one row of
 * suggestion chips per matched span. Focus stays on the input (aria-activedescendant), so mousedown never blurs it.
 */
export default function SuggestionPanel({ id, layout, sections, highlighted, optionId }: Props) {
  // Arrow keys move the highlight; keep that option visible inside the scrolling list (jsdom has no scrollIntoView).
  useEffect(() => {
    if (highlighted === null) return;
    const el = document.getElementById(optionId(highlighted));
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [highlighted, optionId]);

  const option = (item: PanelItem) => {
    const active = item.key === highlighted;
    const color = kindColor(item.kind);
    return (
      <Box
        key={item.key}
        id={optionId(item.key)}
        role="option"
        aria-selected={active}
        aria-label={item.ariaLabel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={item.pick}
        px={layout === 'chips' ? 'sm' : 'xs'}
        py={4}
        fz="sm"
        style={{
          cursor: 'pointer',
          borderRadius: layout === 'chips' ? 'var(--mantine-radius-xl)' : 'var(--mantine-radius-sm)',
          background:
            layout === 'chips' || active ? `var(--mantine-color-${color}-light)` : undefined,
          // A chip sits on its tint; a list row usually does not, so it needs the ink colour to stay readable in dark.
          color: layout === 'chips' ? `var(--mantine-color-${color}-light-color)` : inkColor(color),
          outline: active ? `2px solid var(--mantine-color-${color}-filled)` : undefined,
        }}
      >
        <ChipLabel kind={item.kind} label={item.label} />
      </Box>
    );
  };

  if (layout === 'chips') {
    return (
      <Stack id={id} role="listbox" aria-label="Suggestions" gap={6} mt={6}>
        {sections.map((s) => (
          <Group key={s.key} role="group" aria-label={s.heading} gap={6}>
            {s.items.map(option)}
          </Group>
        ))}
      </Stack>
    );
  }

  return (
    <Paper
      id={id}
      role="listbox"
      aria-label="Suggestions"
      shadow="md"
      withBorder
      p="xs"
      pos="absolute"
      left={0}
      right={0}
      mt={4}
      mah={320}
      style={{ overflowY: 'auto', zIndex: 200 }}
      // Pressing a heading or the padding must not blur the input, which would close the list.
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
    >
      {sections.map((s) => (
        <Box key={s.key} role="group" aria-labelledby={`${id}-${s.key}`} mb="xs">
          <Text id={`${id}-${s.key}`} size="xs" fw={600} c="dimmed" mb={2}>
            {s.heading}
          </Text>
          {s.items.map(option)}
        </Box>
      ))}
    </Paper>
  );
}
