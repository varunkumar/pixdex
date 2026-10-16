import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { workerApiClient } from "../services/api/WorkerApiClient";
import type { PersonSummary, SerializedFace } from "../types/api";
import FaceTile from "./FaceTile";

const STATUS_LABEL: Record<SerializedFace["status"], string> = {
  auto: "Auto-matched",
  confirmed: "Confirmed",
  unassigned: "Unnamed",
};

// Naming faces changes what searches and listings return.
const SEARCH_KEYS = [
  "search",
  "album-photos",
  "albums-page",
  "dailyPick",
  "recent-photos",
];

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return message.includes("409")
    ? "That name already exists"
    : "Could not save the name";
}

const FaceRow = ({
  face,
  index,
  people,
  onNamed,
  onChanged,
}: {
  face: SerializedFace;
  index: number;
  people: PersonSummary[];
  onNamed: (personId: string) => Promise<void>;
  onChanged: () => void;
}) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const assign = useMutation({
    mutationFn: async (personId: string) => {
      await workerApiClient.assignFace(face.id, personId);
      await onNamed(personId);
    },
  });
  const create = useMutation({
    mutationFn: async (newName: string) => {
      const person = await workerApiClient.createPerson(newName, [face.id]);
      await onNamed(person.id);
    },
    onSuccess: () => {
      setCreating(false);
      setName("");
    },
  });
  const reject = useMutation({
    mutationFn: (personId: string) =>
      workerApiClient.rejectFace(face.id, personId),
    onSuccess: onChanged,
  });
  const unassign = useMutation({
    mutationFn: () => workerApiClient.unassignFace(face.id),
    onSuccess: onChanged,
  });

  const error = assign.error ?? create.error ?? reject.error ?? unassign.error;
  const named = face.personId != null && face.status !== "unassigned";
  const busy =
    assign.isPending ||
    create.isPending ||
    reject.isPending ||
    unassign.isPending;

  return (
    <Group data-testid="face-row" align="flex-start" wrap="nowrap" gap="md">
      <Stack gap={2} align="center">
        <Badge size="sm" circle>
          {index + 1}
        </Badge>
        <FaceTile face={face} />
      </Stack>
      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {STATUS_LABEL[face.status]}
        </Text>

        {named ? (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              color="red"
              disabled={busy}
              onClick={() => reject.mutate(face.personId as string)}
            >
              Not {face.personName}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              onClick={() => unassign.mutate()}
            >
              Remove name
            </Button>
          </Group>
        ) : creating ? (
          <Group gap="xs" align="flex-end">
            <TextInput
              aria-label="Person name"
              placeholder="Name"
              size="xs"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Button
              size="xs"
              loading={create.isPending}
              disabled={name.trim() === ""}
              onClick={() => create.mutate(name.trim())}
            >
              Save name
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </Group>
        ) : (
          <Group gap="xs" align="flex-end">
            <Select
              aria-label="Existing person"
              placeholder="Choose a person"
              size="xs"
              searchable
              data={people.map((p) => ({ value: p.id, label: p.name }))}
              value={null}
              disabled={busy}
              onChange={(value) => value && assign.mutate(value)}
            />
            <Button size="xs" variant="light" onClick={() => setCreating(true)}>
              New person
            </Button>
          </Group>
        )}

        {error && (
          <Text size="xs" c="red">
            {errorMessage(error)}
          </Text>
        )}
      </Stack>
    </Group>
  );
};

/** Faces found in a photo, with controls to name them and correct automatic matches. */
const PhotoFaces = ({
  photoId,
  thumbnailUrl,
}: {
  photoId: string;
  thumbnailUrl: string;
}) => {
  const queryClient = useQueryClient();
  const { data: faces = [] } = useQuery({
    queryKey: ["photo-faces", photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  const { data: people = [] } = useQuery({
    queryKey: ["people"],
    queryFn: () => workerApiClient.getPeople(),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["photo-faces", photoId] });
    void queryClient.invalidateQueries({ queryKey: ["people"] });
    for (const key of SEARCH_KEYS)
      void queryClient.invalidateQueries({ queryKey: [key] });
  };

  // After naming a face, attach the person's other unnamed faces automatically.
  const onNamed = async (personId: string) => {
    try {
      const { matched } = await workerApiClient.matchPersonAll(personId);
      if (matched > 0) {
        notifications.show({
          message: `Matched ${matched} more photo${matched === 1 ? "" : "s"}`,
        });
      }
    } finally {
      refresh();
    }
  };

  if (faces.length === 0) return null;

  return (
    <Card withBorder data-testid="photo-faces">
      <Stack gap="md">
        <Title order={5}>Faces</Title>
        <Box pos="relative" w="fit-content" maw="100%">
          <Image
            src={thumbnailUrl}
            alt=""
            radius="md"
            mah={400}
            fit="contain"
          />
          {faces.map((f, i) => (
            <Box
              key={f.id}
              data-testid="face-box"
              pos="absolute"
              style={{
                left: `${f.bbox.x * 100}%`,
                top: `${f.bbox.y * 100}%`,
                width: `${f.bbox.w * 100}%`,
                height: `${f.bbox.h * 100}%`,
                border: "2px solid var(--mantine-color-blue-5)",
                borderRadius: 4,
                pointerEvents: "none",
              }}
            >
              <Badge
                data-testid={`face-box-${i + 1}`}
                size="xs"
                circle
                style={{ position: "absolute", top: -8, left: -8 }}
              >
                {i + 1}
              </Badge>
            </Box>
          ))}
        </Box>
        <Stack gap="md">
          {faces.map((f, i) => (
            <FaceRow
              key={f.id}
              face={f}
              index={i}
              people={people}
              onNamed={onNamed}
              onChanged={refresh}
            />
          ))}
        </Stack>
      </Stack>
    </Card>
  );
};

export default PhotoFaces;
