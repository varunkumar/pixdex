import { Box, Button, Group, Pill, PillsInput, TextInput, UnstyledButton } from '@mantine/core';
import { useId, useImperativeHandle, useState, type KeyboardEvent, type Ref } from 'react';
import { MdAutoAwesome } from 'react-icons/md';
import { useOmniboxData, type OmniboxSelection } from '../../hooks/useOmniboxData';
import { removeWords, type Candidate, type CandidateKind, type Span } from '../../services/omnibox/matcher';
import { MAX_PEOPLE_FILTER } from '../../services/peopleSelection';
import { kindColor } from '../chipStyle';
import SuggestionPanel, {
  ALBUM_GROUP,
  ChipLabel,
  KNOWN_GROUP,
  OWN_GROUP,
  type PanelItem,
  type PanelSection,
} from './SuggestionPanel';

export interface OmniboxProps {
  text: string;
  onText: (t: string) => void;
  selection: OmniboxSelection;
  /**
   * One call per change, e.g. `{ people: [...] }`. When a pick also trims the typed words, `nextText` carries the new
   * text in the same call (and `onText` is not called), so the parent makes one update.
   */
  onSelection: (patch: Partial<OmniboxSelection>, nextText?: string) => void;
  /** Enter. */
  onSubmit: () => void;
  /** Present only where the Prompt API is supported; Cmd/Ctrl+Enter. */
  onAskAi?: () => void;
  askAiBusy?: boolean;
  /** Present only where the Prompt API is supported, in plain mode: opens the keyword row without the model. */
  onAddKeywords?: () => void;
  /** AI mode only. `handle.commit()` commits the keyword draft (if any) and searches again, as Enter in the keyword box. */
  keywordChips?: {
    terms: string[];
    onChange: (terms: string[]) => void;
    onSearchAgain: (terms: string[]) => void;
    handle?: Ref<KeywordRowHandle>;
  };
}

const MAX_CHIPS_PER_SPAN = 3;

function dateLabel({ from, to, onThisDay }: OmniboxSelection): string | null {
  if (onThisDay !== '') return `On this day (${onThisDay})`;
  if (from !== '' && to !== '') return `${from} to ${to}`;
  if (from !== '') return `From ${from}`;
  if (to !== '') return `Until ${to}`;
  return null;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean);

/**
 * The search bar: selected filters as removable chips, free text, and suggestions from the cached lists. Typing alone
 * never changes the selection; only picking a suggestion does. No request per keystroke (the hook debounces and caches).
 */
export default function Omnibox(props: OmniboxProps) {
  const { text, onText, selection, onSelection, onSubmit, onAskAi, askAiBusy = false, onAddKeywords, keywordChips } = props;
  const { candidates, labelFor, spans, bothCount } = useOmniboxData(text, selection);
  const [focused, setFocused] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // Escape closes the panel (either layout); focus, typing and ArrowDown/ArrowUp reopen it.
  const [open, setOpen] = useState(true);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const optionId = (key: string) => `${baseId}-opt-${key.replace(/[^\w-]/g, '_')}`;

  const { people, known, album } = selection;
  const canAddPerson = people.length + known.length < MAX_PEOPLE_FILTER;
  const allowed = (c: Candidate) => c.kind === 'album' || canAddPerson;

  const pick = (c: Candidate, span?: Span) => {
    const patch: Partial<OmniboxSelection> =
      c.kind === 'own' ? { people: [...people, c.id] } : c.kind === 'known' ? { known: [...known, c.id] } : { album: c.id };
    if (span) onSelection(patch, removeWords(text, [span]));
    else onSelection(patch);
    setHighlighted(null);
  };

  // Spans are computed from the debounced text; drop any that no longer line up with the current text.
  const current = words(text);
  const liveSpans = spans.filter((s) => current.slice(s.start, s.end).join(' ') === s.words);

  let layout: 'list' | 'chips' | null = null;
  let sections: PanelSection[] = [];
  if (!open) {
    // closed by Escape
  } else if (text.trim() === '') {
    if (focused) {
      const group = (kind: CandidateKind, heading: string): PanelSection => ({
        key: kind,
        heading,
        items: candidates
          .filter((c) => c.kind === kind && allowed(c))
          .map((c) => ({ key: `${c.kind}:${c.id}`, kind: c.kind, label: c.label, pick: () => pick(c) })),
      });
      sections = [group('own', OWN_GROUP), group('known', KNOWN_GROUP), group('album', ALBUM_GROUP)];
      layout = 'list';
    }
  } else {
    sections = liveSpans.map((s, i) => {
      const ok = s.matches.filter(allowed);
      return {
        key: `span${i}`,
        heading: `Matches for ${s.words}`,
        items: ok.slice(0, MAX_CHIPS_PER_SPAN).map((c) => ({
          key: `${i}:${c.kind}:${c.id}`,
          kind: c.kind,
          label: c.label,
          pick: () => pick(c, s),
        })),
        more: Math.max(0, ok.length - MAX_CHIPS_PER_SPAN),
      };
    });
    const bothSpans = liveSpans.filter((s) => bothCount?.ids.includes(s.matches[0]));
    if (bothCount && bothCount.total !== null && bothSpans.length >= 2) {
      const n = bothCount.total;
      const ids = bothCount.ids;
      sections.push({
        key: 'both',
        heading: 'Add all people',
        items: [
          {
            key: 'both',
            kind: 'both',
            label: `Add both (${n} ${n === 1 ? 'photo' : 'photos'})`,
            pick: () => {
              onSelection(
                {
                  people: [...people, ...ids.filter((c) => c.kind === 'own').map((c) => c.id)],
                  known: [...known, ...ids.filter((c) => c.kind === 'known').map((c) => c.id)],
                },
                removeWords(text, bothSpans),
              );
              setHighlighted(null);
            },
          },
        ],
      });
    }
    layout = 'chips';
  }
  sections = sections.filter((s) => s.items.length > 0);
  if (sections.length === 0) layout = null;
  const items: PanelItem[] = sections.flatMap((s) => s.items);
  const active = items.findIndex((it) => it.key === highlighted);

  const askAi = () => {
    if (onAskAi && !askAiBusy) onAskAi();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (items.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = active < 0 ? (step === 1 ? 0 : items.length - 1) : (active + step + items.length) % items.length;
      setHighlighted(items[next].key);
    } else if (e.key === 'Escape') {
      setHighlighted(null);
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && onAskAi) askAi();
      else if (active >= 0) items[active].pick();
      else onSubmit();
    }
  };

  const chip = (kind: CandidateKind | 'date', key: string, label: string, remove: () => void) => {
    const color = kindColor(kind);
    return (
      <Pill
        key={key}
        data-chip={kind}
        withRemoveButton
        onRemove={remove}
        removeButtonProps={{ 'aria-label': `Remove ${label}`, 'aria-hidden': false, tabIndex: 0 }}
        bg={`var(--mantine-color-${color}-light)`}
        c={`var(--mantine-color-${color}-light-color)`}
      >
        {kind === 'date' ? label : <ChipLabel kind={kind} label={label} />}
      </Pill>
    );
  };
  const date = dateLabel(selection);

  return (
    <Box pos="relative">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <PillsInput style={{ flex: 1 }}>
          <Pill.Group>
            {album !== '' && chip('album', 'album', album, () => onSelection({ album: '' }))}
            {people.map((id) =>
              chip('own', `own:${id}`, labelFor('own', id) ?? 'Person', () =>
                onSelection({ people: people.filter((p) => p !== id) }),
              ),
            )}
            {known.map((id) =>
              chip('known', `known:${id}`, labelFor('known', id) ?? id, () =>
                onSelection({ known: known.filter((k) => k !== id) }),
              ),
            )}
            {date && chip('date', 'date', date, () => onSelection({ from: '', to: '', onThisDay: '' }))}
            <PillsInput.Field
              role="combobox"
              aria-label="Search"
              aria-expanded={layout !== null}
              aria-controls={layout !== null ? panelId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(items[active].key) : undefined}
              placeholder="Search photos, people, albums"
              value={text}
              onChange={(e) => {
                onText(e.currentTarget.value);
                setHighlighted(null);
                setOpen(true);
              }}
              onFocus={() => {
                setFocused(true);
                setOpen(true);
              }}
              onBlur={() => {
                setFocused(false);
                setHighlighted(null);
              }}
              onKeyDown={onKeyDown}
            />
          </Pill.Group>
        </PillsInput>
        {onAskAi && (
          <Button
            variant="light"
            leftSection={<MdAutoAwesome aria-hidden />}
            loading={askAiBusy}
            onClick={askAi}
          >
            Ask AI
          </Button>
        )}
        {onAddKeywords && (
          <Button variant="subtle" onClick={onAddKeywords}>
            Add keywords
          </Button>
        )}
      </Group>
      {layout !== null && (
        <SuggestionPanel id={panelId} layout={layout} sections={sections} highlighted={highlighted} optionId={optionId} />
      )}
      {keywordChips && <KeywordRow {...keywordChips} />}
    </Box>
  );
}

export interface KeywordRowHandle {
  commit: () => void;
}

function KeywordRow({ terms, onChange, onSearchAgain, handle }: NonNullable<OmniboxProps['keywordChips']>) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<number | null>(null);

  const commit = () => {
    const typed = draft.split(',').map((t) => t.trim()).filter(Boolean);
    let next = terms;
    if (typed.length > 0) {
      const merged =
        editing === null ? [...terms, ...typed] : [...terms.slice(0, editing), ...typed, ...terms.slice(editing + 1)];
      next = merged.filter((t, i) => merged.indexOf(t) === i);
      onChange(next);
    }
    setDraft('');
    setEditing(null);
    onSearchAgain(next);
  };
  useImperativeHandle(handle, () => ({ commit }));

  return (
    <Group gap={6} mt={6} wrap="wrap">
      {terms.map((t, i) => (
        <Pill
          key={`${t}-${i}`}
          withRemoveButton
          onRemove={() => onChange(terms.filter((_, j) => j !== i))}
          removeButtonProps={{ 'aria-label': `Remove keyword ${t}`, 'aria-hidden': false, tabIndex: 0 }}
          bg="var(--mantine-color-gray-light)"
          c="var(--mantine-color-gray-light-color)"
        >
          <UnstyledButton
            aria-label={`Edit keyword ${t}`}
            fz="inherit"
            c="inherit"
            onClick={() => {
              setDraft(t);
              setEditing(i);
            }}
          >
            {t}
          </UnstyledButton>
        </Pill>
      ))}
      <TextInput
        size="xs"
        aria-label="Add keywords"
        placeholder={editing === null ? 'Add keywords' : 'Edit keyword'}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft('');
            setEditing(null);
          }
        }}
      />
    </Group>
  );
}
