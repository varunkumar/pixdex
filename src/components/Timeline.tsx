import { Box, Button, Card, Group, Loader, MultiSelect, SegmentedControl, Select, Stack, Text, Title } from '@mantine/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTimelineParams, ZOOMS } from '../hooks/useTimelineParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { TimelineGroup, TimelineZoom } from '../types/api';
import PhotoGrid from './PhotoGrid';
import TimelineScrubber from './TimelineScrubber';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ZOOM_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const ZOOM_DEBOUNCE_MS = 150;
// Finger spread ratio that counts as one zoom step.
const PINCH_STEP = 1.3;

// Parsed by hand so the label never shifts with the viewer's timezone or locale.
function groupHeading(key: string): string {
  if (key === 'undated') return 'Undated';
  const [y, m, d] = key.split('-').map(Number);
  if (d === undefined) return `${MONTHS[m - 1]} ${y}`;
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

// "2025-03-31" -> "Mar 2025", parsed by hand like the headings.
function toLabel(to: string): string {
  const [y, m] = to.split('-').map(Number);
  return y && m >= 1 && m <= 12 ? `${MONTHS[m - 1].slice(0, 3)} ${y}` : to;
}

// A heading counts as "at the top" once it has scrolled up past the sticky bar.
const ACTIVE_OFFSET = 120;
const SCRUBBER_GUTTER = 64;

const groupCount = ({ total, shown }: TimelineGroup) => {
  const photos = `${total} ${total === 1 ? 'photo' : 'photos'}`;
  return shown === 0 ? `${photos}, zoom in to see` : `${photos}, ${shown} shown`;
};

const pinchDistance = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

const Timeline = () => {
  const { zoom, album, people, to, setZoom, setFilters, jumpTo } = useTimelineParams();
  const peopleKey = people.join(',');

  const { data: albums = [] } = useQuery({ queryKey: ['album-names'], queryFn: () => workerApiClient.getAlbums() });
  const { data: namedPeople = [] } = useQuery({ queryKey: ['people'], queryFn: () => workerApiClient.getPeople() });
  const peopleOptions = namedPeople.map((p) => ({ value: p.id, label: p.name }));

  // Keyed by album and people only, so the scrubber lists every month with photos whatever the zoom, jump or rating cut-off.
  const { data: bucketData } = useQuery({
    queryKey: ['timeline-buckets', album, peopleKey],
    queryFn: () => workerApiClient.getTimelineBuckets({ ...(album && { album }), ...(people.length > 0 && { people }) }),
  });

  const {
    data,
    isPending,
    isFetching,
    error,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ['timeline', zoom, album, peopleKey, to],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      workerApiClient.getTimeline({
        zoom,
        ...(album && { album }),
        ...(people.length > 0 && { people }),
        ...(to && { to }),
        ...(pageParam && { cursor: pageParam }),
      }),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });

  const groups = data?.pages.flatMap((p) => p.groups) ?? [];

  const [activeMonth, setActiveMonth] = useState<string | null>(null);

  // Zooming keeps the period being read: once the reader has moved past the
  // newest month (or has jumped), the new zoom starts at the end of the active month.
  const changeZoom = (z: TimelineZoom) => {
    if (z === zoom) return;
    const newest = groups[0]?.key.slice(0, 7);
    const keepMonth = activeMonth && (to || activeMonth !== newest) ? activeMonth : undefined;
    setZoom(z, keepMonth);
    if (keepMonth) window.scrollTo({ top: 0 });
  };

  // Zoom gestures read the latest zoom through a ref so a stale listener never steps from an old level.
  const zoomRef = useRef<TimelineZoom>(zoom);
  const setZoomRef = useRef(changeZoom);
  useEffect(() => {
    zoomRef.current = zoom;
    setZoomRef.current = changeZoom;
  });

  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    let pending = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Steps accumulate for a moment, then move at most one level, so a fast wheel flick is not a leap.
    const step = (dir: -1 | 1) => {
      pending += dir;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dir = Math.sign(pending);
        pending = 0;
        if (dir === 0) return;
        const next = ZOOMS[ZOOMS.indexOf(zoomRef.current) + dir];
        if (next) setZoomRef.current(next);
      }, ZOOM_DEBOUNCE_MS);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      // Up (negative deltaY) zooms in toward Day, down out toward Year.
      step(e.deltaY < 0 ? -1 : 1);
    };

    let startDistance = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) startDistance = pinchDistance(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || startDistance === 0) return;
      const ratio = pinchDistance(e.touches) / startDistance;
      if (ratio > PINCH_STEP) step(-1);
      else if (ratio < 1 / PINCH_STEP) step(1);
      else return;
      startDistance = pinchDistance(e.touches);
    };
    const onTouchEnd = () => {
      startDistance = 0;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const updateActiveMonth = useCallback(() => {
    const headings = surfaceRef.current?.querySelectorAll<HTMLElement>('[data-group-key]');
    if (!headings || headings.length === 0) return setActiveMonth(null);
    let current = headings[0];
    for (const h of headings) {
      if (h.getBoundingClientRect().top > ACTIVE_OFFSET) break;
      current = h;
    }
    const key = current.dataset.groupKey ?? '';
    setActiveMonth(key === 'undated' ? null : key.slice(0, 7));
  }, []);
  useEffect(() => {
    updateActiveMonth();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActiveMonth();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [updateActiveMonth, groups.length]);

  const handleJump = (month: string) => {
    jumpTo(month);
    window.scrollTo({ top: 0 });
  };

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    // After a failed page, wait for an explicit retry: re-observing would refetch in a loop.
    if (!el || !hasNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, groups.length]);

  return (
    // Right padding at md and up keeps photos clear of the fixed scrubber rail.
    <Stack gap="lg" data-testid="timeline-content" pr={{ base: 0, md: SCRUBBER_GUTTER }}>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Timeline</Title>
        <SegmentedControl
          aria-label="Timeline zoom"
          data={ZOOM_OPTIONS}
          value={zoom}
          onChange={(v) => changeZoom(v as TimelineZoom)}
        />
      </Group>

      {to && (
        <Group gap="sm">
          <Text size="sm">Showing photos up to {toLabel(to)}</Text>
          <Button size="compact-sm" variant="light" onClick={() => setFilters({ to: '' })}>
            Back to latest
          </Button>
        </Group>
      )}

      <Card withBorder>
        <Group align="flex-end" gap="md" grow preventGrowOverflow={false}>
          <Select
            label="Album"
            aria-label="Select photo album"
            placeholder="All albums"
            data={albums}
            value={album || null}
            onChange={(value) => setFilters({ album: value ?? '' })}
            clearable
            searchable
          />
          {peopleOptions.length > 0 && (
            <MultiSelect
              label="People"
              placeholder={people.length === 0 ? 'Anyone' : undefined}
              data={peopleOptions}
              value={people.filter((id) => peopleOptions.some((o) => o.value === id))}
              onChange={(ids) => setFilters({ people: ids })}
              maxValues={5}
              clearable
              searchable
              hidePickedOptions
            />
          )}
        </Group>
      </Card>

      <Box ref={surfaceRef} data-testid="timeline-grid" style={{ touchAction: 'pan-y' }}>
        {error && !data ? (
          <Group gap="sm">
            <Text c="red">Could not load the timeline.</Text>
            <Button size="compact-sm" variant="light" loading={isFetching} onClick={() => void refetch()}>
              Retry
            </Button>
          </Group>
        ) : isPending ? (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        ) : groups.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            {album || people.length > 0 || to ? 'No photos match these filters.' : 'No photos to show.'}
          </Text>
        ) : (
          <Stack gap="lg">
            {groups.map((group) => (
              <Box key={group.key} data-group-key={group.key}>
                <Group
                  gap="sm"
                  align="baseline"
                  py="xs"
                  mb="sm"
                  style={{ position: 'sticky', top: 60, zIndex: 5, background: 'var(--mantine-color-body)' }}
                >
                  <Title order={4}>{groupHeading(group.key)}</Title>
                  <Text size="sm" c="dimmed">
                    {groupCount(group)}
                  </Text>
                </Group>
                {group.photos.length > 0 && <PhotoGrid photos={group.photos} />}
              </Box>
            ))}
          </Stack>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
        {isFetchNextPageError && (
          <Group justify="center" py="md" gap="sm">
            <Text c="red" size="sm">
              Could not load more photos.
            </Text>
            <Button
              size="compact-sm"
              variant="light"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Retry
            </Button>
          </Group>
        )}
        {isFetchingNextPage && (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        )}
      </Box>
      <TimelineScrubber buckets={bucketData?.buckets ?? []} activeMonth={activeMonth} onJump={handleJump} />
    </Stack>
  );
};

export default Timeline;
