import {
  Group,
  MultiSelect,
  Pill,
  Text,
  VisuallyHidden,
  type ComboboxItem,
  type ComboboxParsedItem,
  type OptionsFilter,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { MdVerified } from 'react-icons/md';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { personOptions } from '../services/peopleKeys';
import { MAX_PEOPLE_FILTER } from '../services/peopleSelection';
import { matchesQuery } from '../services/personMatch';

const FIVE_MINUTES = 5 * 60 * 1000;
const OWN_GROUP = 'Your people';
const KNOWN_GROUP = 'Known personalities in your photos';
// Own entries are blue, known ones violet. Known ones also carry a "known" marker and the group heading,
// so colour is never the only signal (light and dark themes, colour-blind users).
const OWN_COLOR = 'blue';
const KNOWN_COLOR = 'violet';

interface Props {
  people: string[];
  known: string[];
  onChange: (next: { people: string[]; known: string[] }) => void;
}

// Typing narrows the list only from 3 characters (the owner's design): "m" shows nothing, "man" finds "Rahman".
// An empty box still lists everyone.
const MIN_QUERY = 3;

const isKnown = (value: string) => value.startsWith('k:');

/**
 * One People box over two lists: the viewer's own people ("p:" values) and the known personalities found in the
 * photos they can see ("k:" values, so the two id spaces never collide). Both are always shown, even for the same
 * real person. Matching is local (no request per keystroke) and only a picked option, never typing, filters.
 */
const PeopleFilter = ({ people, known, onChange }: Props) => {
  const { data: own = [], isSuccess: ownLoaded } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
    staleTime: FIVE_MINUTES,
  });
  const { data: knownList = [], isSuccess: knownLoaded } = useQuery({
    queryKey: ['known-people'],
    queryFn: () => workerApiClient.getKnownPeople(),
    staleTime: FIVE_MINUTES,
  });

  if (own.length === 0 && knownList.length === 0) return null;

  const ownOptions = personOptions(own).map((o) => ({ value: `p:${o.value}`, label: o.label }));
  const knownOptions = knownList.map((k) => ({ value: `k:${k.id}`, label: k.name }));
  // Aliases are searchable but never shown; own entries match on their label only.
  const aliases = new Map(knownList.map((k) => [`k:${k.id}`, k.aliases]));

  // Own group first, so own names rank above known ones on ties.
  const data = [
    ...(ownOptions.length > 0 ? [{ group: OWN_GROUP, items: ownOptions }] : []),
    ...(knownOptions.length > 0 ? [{ group: KNOWN_GROUP, items: knownOptions }] : []),
  ];

  const filter: OptionsFilter = ({ options, search }) => {
    const matches = (o: ComboboxItem) => matchesQuery(search, [o.label, ...(aliases.get(o.value) ?? [])], MIN_QUERY);
    const out: ComboboxParsedItem[] = [];
    for (const item of options) {
      if ('group' in item) {
        const items = item.items.filter(matches);
        if (items.length > 0) out.push({ ...item, items });
      } else if (matches(item)) out.push(item);
    }
    return out;
  };

  const ownIds = new Set(own.map((p) => p.id));
  const knownIds = new Set(knownList.map((k) => k.id));
  const value = [
    ...people.filter((id) => ownIds.has(id)).map((id) => `p:${id}`),
    ...known.filter((id) => knownIds.has(id)).map((id) => `k:${id}`),
  ];

  // The two lists load separately. While one has not loaded (or failed) its ids are not shown in `value`, so they
  // are carried through from the props unchanged instead of being dropped from the URL.
  const carriedPeople = ownLoaded ? [] : people;
  const carriedKnown = knownLoaded ? [] : known;
  const change = (values: string[]) => {
    const next = values.slice(0, Math.max(0, MAX_PEOPLE_FILTER - carriedPeople.length - carriedKnown.length));
    onChange({
      people: [...carriedPeople, ...next.filter((v) => !isKnown(v)).map((v) => v.slice(2))],
      known: [...carriedKnown, ...next.filter(isKnown).map((v) => v.slice(2))],
    });
  };

  return (
    <MultiSelect
      label="People"
      placeholder={value.length === 0 ? 'Anyone' : undefined}
      data={data}
      value={value}
      onChange={change}
      filter={filter}
      maxValues={MAX_PEOPLE_FILTER}
      clearable
      searchable
      hidePickedOptions
      renderOption={({ option }) => {
        const k = isKnown(option.value);
        return (
          <Group gap="xs" wrap="nowrap" justify="space-between" w="100%">
            <Text component="span" size="sm" c={`${k ? KNOWN_COLOR : OWN_COLOR}.7`}>
              {option.label}
            </Text>
            {k && (
              <Group component="span" gap={2} wrap="nowrap" c={`${KNOWN_COLOR}.7`}>
                <MdVerified aria-hidden size={12} />
                <Text component="span" size="xs" fw={500} c="inherit">
                  known
                </Text>
              </Group>
            )}
          </Group>
        );
      }}
      renderPill={({ option, onRemove, disabled }) => {
        const k = isKnown(String(option.value));
        const color = k ? KNOWN_COLOR : OWN_COLOR;
        return (
          <Pill
            withRemoveButton={!disabled}
            onRemove={onRemove}
            bg={`var(--mantine-color-${color}-light)`}
            c={`var(--mantine-color-${color}-light-color)`}
          >
            {k && <MdVerified aria-hidden size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />}
            {option.label}
            {k && <VisuallyHidden> (known personality)</VisuallyHidden>}
          </Pill>
        );
      }}
    />
  );
};

export default PeopleFilter;
