import { Anchor, Box, Button, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { TbCheck, TbX } from 'react-icons/tb';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useHistoryState } from '../hooks/useHistoryState';
import { useLastAddress } from '../hooks/useLastAddress';
import { useReviewQueue } from '../hooks/useReviewQueue';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { noteRemovedName, refreshAfterReview } from '../services/matchQueue';
import { errorMessage, UNNAMED_PERSON } from '../services/peopleKeys';
import { finishedReviews, noteReviewFinished } from '../services/reviewVisit';
import type { PersonSummary, SerializedFace } from '../types/api';
import BackLink from './BackLink';
import FaceTile from './FaceTile';

const TILE = 96;

type Picture = 'loaded' | 'failed';

/** One crop: a click keeps or unkeeps it. A face whose picture failed cannot be chosen. */
const ReviewTile = ({
  face,
  number,
  name,
  ticked,
  picture,
  onPicture,
  onToggle,
}: {
  face: SerializedFace;
  /** Position on the page, from 1, so every control has its own name. */
  number: number;
  name: string;
  ticked: boolean;
  picture: Picture | undefined;
  onPicture: (state: Picture) => void;
  onToggle: () => void;
}) => (
  <Stack gap={4} align="center" w={TILE}>
    {/* The same URL FaceTile paints as a background, loaded here to know whether there is anything to see. */}
    <img
      data-face-picture
      alt=""
      hidden
      src={workerApiClient.thumbnailUrl({ thumbnailUrl: face.cropUrl ?? face.thumbnailUrl })}
      onLoad={() => onPicture('loaded')}
      onError={() => onPicture('failed')}
    />
    {picture === 'failed' ? (
      <Box w={TILE} h={TILE} style={{ display: 'flex', alignItems: 'center' }}>
        <Text size="xs" c="dimmed" ta="center">
          Picture did not load
        </Text>
      </Box>
    ) : (
      <UnstyledButton pos="relative" aria-pressed={ticked} aria-label={`Face ${number} is ${name}`} onClick={onToggle}>
        <Box opacity={ticked ? 1 : 0.35}>
          <FaceTile face={{ ...face, personName: null }} size={TILE} />
        </Box>
        <Box
          pos="absolute"
          top={4}
          right={4}
          w={22}
          h={22}
          c="white"
          bg={ticked ? 'teal' : 'red'}
          style={{ borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {ticked ? <TbCheck aria-hidden /> : <TbX aria-hidden />}
        </Box>
      </UnstyledButton>
    )}
    <Anchor
      component={Link}
      to={`/photos/${face.photoId}`}
      target="_blank"
      size="xs"
      aria-label={`Open the photo of face ${number}`}
    >
      Open photo
    </Anchor>
  </Stack>
);

const resultMessage = (confirmed: number, rejected: number, skipped: number, name: string) => {
  const done = [confirmed && `confirmed ${confirmed}`, rejected && `marked ${rejected} as Not ${name}`].filter(Boolean).join(', ');
  const first = done ? `${done[0].toUpperCase()}${done.slice(1)}.` : '';
  const rest = skipped ? `${skipped} had changed and ${skipped === 1 ? 'was' : 'were'} skipped.` : '';
  return [first, rest].filter(Boolean).join(' ');
};

/** One page of crops, all ticked. The buttons only ever act on the faces shown here. */
const ReviewPage = ({
  personId,
  name,
  faces,
  unticked: untickedIds,
  onToggle,
  onDone,
}: {
  personId: string;
  name: string;
  faces: SerializedFace[];
  unticked: readonly string[];
  onToggle: (faceId: string) => void;
  /** Moves to the next page; `message` says what was saved. */
  onDone: (message: string | null) => void;
}) => {
  const queryClient = useQueryClient();
  const unticked = new Set(untickedIds);
  const [pictures, setPictures] = useState<ReadonlyMap<string, Picture>>(new Map());
  // A second click can land before the buttons re-render as busy.
  const sending = useRef(false);
  const save = useMutation({
    mutationFn: (body: { confirm: string[]; reject: string[] }) => workerApiClient.reviewAutoFaces(personId, body),
    onSuccess: ({ confirmed, rejected }, body) => {
      for (const faceId of rejected) noteRemovedName(queryClient, faceId, personId);
      refreshAfterReview(queryClient);
      const skipped = body.confirm.length + body.reject.length - confirmed.length - rejected.length;
      onDone(resultMessage(confirmed.length, rejected.length, skipped, name));
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const send = (confirm: string[], reject: string[]) => {
    if (sending.current) return;
    sending.current = true;
    save.mutate({ confirm, reject });
  };

  const settled = faces.every((f) => pictures.has(f.id));
  const seen = faces.filter((f) => pictures.get(f.id) !== 'failed');
  const keep = seen.filter((f) => !unticked.has(f.id)).map((f) => f.id);
  const drop = seen.filter((f) => unticked.has(f.id)).map((f) => f.id);

  return (
    <Stack gap="md">
      <Group gap="sm" align="flex-start">
        {faces.map((f, i) => (
          <ReviewTile
            key={f.id}
            face={f}
            number={i + 1}
            name={name}
            ticked={!unticked.has(f.id)}
            picture={pictures.get(f.id)}
            onPicture={(state) => setPictures((prev) => new Map(prev).set(f.id, state))}
            onToggle={() => onToggle(f.id)}
          />
        ))}
      </Group>
      <Group gap="xs">
        {(keep.length > 0 || drop.length === 0) && (
          <Button size="xs" disabled={!settled || keep.length === 0 || save.isPending} onClick={() => send(keep, [])}>
            Confirm {keep.length}
          </Button>
        )}
        {drop.length > 0 && (
          <Button size="xs" variant="light" color="red" disabled={!settled || save.isPending} onClick={() => send(keep, drop)}>
            {keep.length > 0 ? `Confirm ${keep.length}, mark` : 'Mark'} {drop.length} as Not {name}
          </Button>
        )}
        <Button size="xs" variant="subtle" disabled={save.isPending} onClick={() => onDone(null)}>
          Skip page
        </Button>
      </Group>
      {!settled && (
        <Text size="xs" c="dimmed">
          Loading pictures…
        </Text>
      )}
      {save.error && (
        <Text size="sm" c="red">
          {errorMessage(save.error, false)}
        </Text>
      )}
    </Stack>
  );
};

/** The person with the most matches pending, leaving out this one and those already gone through. */
const NextPerson = ({ personId }: { personId: string }) => {
  const queryClient = useQueryClient();
  const queue = useReviewQueue();
  const { data: people = [] } = useQuery<PersonSummary[]>({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
  });
  // Cached counts may predate the saves just made: wait for the fresh ones.
  if (queue.isFetching) return null;
  const done = finishedReviews(queryClient);
  const next = queue.data?.find((p) => p.id !== personId && !done.has(p.id) && people.some((q) => q.id === p.id));
  if (!next) return null;
  const name = people.find((p) => p.id === next.id)?.name ?? UNNAMED_PERSON;
  return (
    <Button component={Link} to={`/people/${next.id}/review`} size="xs">
      Next: {name} ({next.count})
    </Button>
  );
};

interface Position {
  /** Counts "Start again", so the same cursor is requested afresh. */
  round: number;
  cursor?: string;
  done?: boolean;
  /** Faces unticked on the page at `cursor`. */
  unticked: string[];
}

/** Pages through a person's auto matches, weakest first. `done` follows the last page. */
const Review = ({ personId, name }: { personId: string; name: string }) => {
  // The page and its ticks belong to the history entry: Back returns to them, a fresh visit starts over.
  const [position, setPosition] = useHistoryState<Position>(`review:${personId}`, { round: 0, unticked: [] });
  const [message, setMessage] = useState<string | null>(null);
  const { round, cursor, done, unticked } = position;
  // The page on screen must not change under the ticks: no refetch on focus, reconnect or age.
  const query = useQuery({
    queryKey: ['auto-faces', personId, round, cursor ?? ''],
    queryFn: () => workerApiClient.getAutoFaces(personId, cursor),
    enabled: !done,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const page = query.data;
  const finished = done || page?.faces.length === 0;
  const queryClient = useQueryClient();
  useEffect(() => {
    if (finished) noteReviewFinished(queryClient, personId);
  }, [finished, queryClient, personId]);

  return (
    <Stack gap="md">
      {message && <Text size="sm">{message}</Text>}
      {query.error != null && !done && (
        <Group gap="xs">
          <Text size="sm" c="red">
            Could not load the faces
          </Text>
          <Button size="xs" variant="light" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Group>
      )}
      {query.isLoading && <Text c="dimmed">Loading…</Text>}
      {finished ? (
        <Group gap="xs">
          <Text c="dimmed">No more auto matches.</Text>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              setMessage(null);
              setPosition({ round: round + 1, unticked: [] });
            }}
          >
            Start again
          </Button>
          <NextPerson personId={personId} />
        </Group>
      ) : (
        page && (
          <ReviewPage
            key={`${round}:${cursor ?? ''}`}
            personId={personId}
            name={name}
            faces={page.faces}
            unticked={unticked}
            onToggle={(faceId) =>
              setPosition((prev) => ({
                ...prev,
                unticked: prev.unticked.includes(faceId)
                  ? prev.unticked.filter((id) => id !== faceId)
                  : [...prev.unticked, faceId],
              }))
            }
            onDone={(saved) => {
              setMessage(saved);
              setPosition(
                page.nextCursor ? { round, cursor: page.nextCursor, unticked: [] } : { round, done: true, unticked: [] }
              );
            }}
          />
        )
      )}
    </Stack>
  );
};

const ReviewAutoFaces = () => {
  const { id = '' } = useParams();
  const { key } = useLocation();
  const personPage = useLastAddress(`/people/${id}`);
  const { data: people = [], isSuccess } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
  });
  const person = people.find((p) => p.id === id);
  const name = person?.name ?? UNNAMED_PERSON;

  return (
    <Stack gap="lg">
      <Group gap="lg">
        <BackLink to={personPage}>{person ? name : 'Person'}</BackLink>
        {person?.canEdit && <BackLink to="/review">To review</BackLink>}
      </Group>
      {isSuccess && !person && <Text c="dimmed">This person was not found.</Text>}
      {person && !person.canEdit && <Text c="dimmed">Only the owner of this person can review their matches.</Text>}
      {person?.canEdit && (
        <>
          <Stack gap={4}>
            <Title order={2}>Review auto matches: {name}</Title>
            <Text size="sm" c="dimmed">
              Weakest matches first. Untick any face that is not {name}. Confirmed faces are never moved by matching.
            </Text>
          </Stack>
          <Review key={`${id}:${key}`} personId={id} name={name} />
        </>
      )}
    </Stack>
  );
};

export default ReviewAutoFaces;
