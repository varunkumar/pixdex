import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MdAutoAwesome, MdSearch } from 'react-icons/md';
import { Navigate, useSearchParams } from 'react-router-dom';
import { usePromptApiSupport } from '../hooks/usePromptApiSupport';
import { runAiSearch, type RankedPhoto } from '../services/aiSearch/pipeline';
import { expandRequest } from '../services/aiSearch/promptApi';
import { normalizeKeywords } from '../services/aiSearch/ranking';
import PhotoCard from './PhotoCard';

type Patch = Record<string, string | null>;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'An error occurred');

const ResultFooter = ({ item }: { item: RankedPhoto }) => (
  <Stack gap={2}>
    <Text size="xs" c="dimmed">
      matched: {item.hits.join(', ')}
    </Text>
    {item.textSpace && (
      <Text size="xs" c="dimmed">
        Text space: {Math.round(item.textSpace.score * 100)}% ({item.textSpace.side})
      </Text>
    )}
    <Text size="xs" c="dimmed">
      Rating: {item.rating.toFixed(1)}
    </Text>
  </Stack>
);

const AiSearchPage = () => {
  const [params, setParams] = useSearchParams();
  const rawQ = params.get('q') ?? '';
  const rawKw = params.get('kw') ?? '';
  const terms = normalizeKeywords(rawKw);
  const hidePeople = params.get('people') !== '0';
  const leaveRoom = params.get('room') !== '0';

  // Functional update: an expansion that finishes later must not undo a switch flipped meanwhile.
  // Defaults (options on, empty text) never reach the URL.
  const update = (patch: Patch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    });

  const [request, setRequest] = useState(rawQ);
  const [syncedQ, setSyncedQ] = useState(rawQ);
  const [kwText, setKwText] = useState(terms.join(', '));
  const [syncedKw, setSyncedKw] = useState(rawKw);

  // Keep the boxes in step with the URL (back/forward, deep links).
  if (syncedQ !== rawQ) {
    setSyncedQ(rawQ);
    setRequest(rawQ);
  }
  if (syncedKw !== rawKw) {
    setSyncedKw(rawKw);
    setKwText(terms.join(', '));
  }

  const [status, setStatus] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);

  const expansion = useMutation({
    mutationFn: (text: string) => expandRequest(text, setStatus),
    onMutate: () => {
      const t = Date.now();
      setStatus('Starting the on-device model');
      setStartedAt(t);
      setNow(t);
    },
  });

  useEffect(() => {
    if (!expansion.isPending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expansion.isPending]);

  const search = useQuery({
    queryKey: ['ai-search', terms, hidePeople, leaveRoom],
    queryFn: () => runAiSearch(terms, { hidePeople, leaveRoom }),
    enabled: terms.length > 0,
  });

  const findPhotos = () => {
    const text = request.trim();
    // Only a successful expansion replaces the keywords; an error leaves the URL as it was.
    // A per-call onSuccess does not fire after unmount, so leaving mid-run cannot navigate back here.
    if (text) expansion.mutate(text, { onSuccess: (result) => update({ q: text, kw: result.keywords.join(',') }) });
  };

  const searchAgain = () => {
    expansion.reset();
    const next = normalizeKeywords(kwText).join(',');
    if (next === terms.join(',')) {
      setKwText(terms.join(', '));
      if (next) void search.refetch();
    } else {
      update({ kw: next });
    }
  };

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const report = search.data?.keywords ?? [];
  const noMatches = report.filter((k) => !k.failed && k.total === 0);
  const failed = report.filter((k) => k.failed);

  return (
    <Stack gap="lg">
      <Title order={2}>AI Search</Title>

      <Card withBorder>
        <Stack gap="md">
          <Textarea
            label="What do you need photos for?"
            placeholder="Professional photos to use for Diwali wishes to my colleagues"
            rows={2}
            value={request}
            onChange={(e) => setRequest(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                findPhotos();
              }
            }}
          />
          <Group justify="space-between" align="center">
            <Group gap="lg">
              <Switch
                label="Hide people photos"
                checked={hidePeople}
                onChange={(e) => update({ people: e.currentTarget.checked ? null : '0' })}
              />
              <Switch
                label="Leave room for text"
                checked={leaveRoom}
                onChange={(e) => update({ room: e.currentTarget.checked ? null : '0' })}
              />
            </Group>
            <Button
              onClick={findPhotos}
              disabled={request.trim() === '' || expansion.isPending}
              leftSection={expansion.isPending ? <Loader size="xs" color="white" /> : <MdAutoAwesome />}
            >
              Find photos
            </Button>
          </Group>

          {expansion.isPending && (
            <Group gap="xs" aria-live="polite">
              <Loader size="xs" />
              <Text size="sm">{status}</Text>
              <Text size="sm" c="dimmed">
                Running on this device, {elapsed}s
              </Text>
            </Group>
          )}

          {expansion.isError && (
            <Alert color="red" title="The on-device model did not produce keywords">
              <Text size="sm">{errorMessage(expansion.error)}</Text>
              <Text size="sm" c="dimmed">
                You can type keywords below and search anyway.
              </Text>
            </Alert>
          )}

          <Group align="flex-end" gap="md">
            <TextInput
              label="Keywords"
              description="Comma separated. Edit them and search again without re-running the model."
              placeholder="diya, golden, rangoli"
              value={kwText}
              onChange={(e) => setKwText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  searchAgain();
                }
              }}
              style={{ flexGrow: 1 }}
            />
            <Button
              variant="light"
              onClick={searchAgain}
              leftSection={terms.length > 0 && search.isFetching ? <Loader size="xs" /> : <MdSearch />}
            >
              Search again
            </Button>
          </Group>

          {(noMatches.length > 0 || failed.length > 0) && (
            <Group gap={6}>
              {noMatches.map((k) => (
                <Badge key={k.term} variant="outline" color="gray" size="sm">
                  {k.term}: no matches
                </Badge>
              ))}
              {failed.map((k) => (
                <Badge key={k.term} variant="light" color="red" size="sm">
                  {k.term}: failed
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
      </Card>

      {terms.length === 0 && !expansion.isPending && (
        <Text c="dimmed">Describe what the photos are for, or type keywords, to find photos.</Text>
      )}

      {terms.length > 0 && search.isPending && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text c="dimmed">Searching and measuring text space...</Text>
        </Group>
      )}

      {terms.length > 0 && search.isError && <Text c="red">{errorMessage(search.error)}</Text>}

      {terms.length > 0 && search.data && search.data.items.length === 0 && (
        <Text c="dimmed">No photos found. Try editing the keywords and searching again.</Text>
      )}

      {terms.length > 0 && search.data && search.data.items.length > 0 && (
        <Stack gap="sm">
          {search.data.hiddenPeople > 0 && (
            <Text size="sm" c="dimmed">
              {search.data.hiddenPeople} people photos hidden.
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {search.data.items.map((item) => (
              <PhotoCard key={item.photo.id} photo={item.photo} footer={<ResultFooter item={item} />} />
            ))}
          </SimpleGrid>
        </Stack>
      )}
    </Stack>
  );
};

const AiSearch = () => {
  const support = usePromptApiSupport();
  if (support === 'checking') return <Loader />;
  if (support === 'unsupported') return <Navigate to="/" replace />;
  return <AiSearchPage />;
};

export default AiSearch;
