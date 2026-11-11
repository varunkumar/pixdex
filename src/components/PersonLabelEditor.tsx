import { Button, Group, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { workerApiClient } from "../services/api/WorkerApiClient";
import { errorMessage, SEARCH_KEYS } from "../services/peopleKeys";

/**
 * Inline editor for the viewer's own private name for a person they do not own. Saving text calls PUT
 * /people/:id/label, saving it empty clears the label (DELETE). Nothing else is offered: the owner's
 * name is never visible here and owner controls stay hidden.
 */
const PersonLabelEditor = ({
  personId,
  name,
}: {
  personId: string;
  name: string | null;
}) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const save = useMutation({
    mutationFn: async (next: string) => {
      if (next === "") {
        if (name !== null) await workerApiClient.clearPersonLabel(personId);
      } else {
        await workerApiClient.setPersonLabel(personId, next);
      }
    },
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["people"] });
      void queryClient.invalidateQueries({ queryKey: ["photo-faces"] });
      for (const key of SEARCH_KEYS)
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  if (!editing) {
    return (
      <Button
        size="compact-xs"
        variant="subtle"
        w="fit-content"
        onClick={() => {
          setText(name ?? "");
          save.reset();
          setEditing(true);
        }}
      >
        {name === null ? "Add my name" : "Edit my name"}
      </Button>
    );
  }
  return (
    <Group gap="xs" align="flex-end">
      <TextInput
        aria-label="My name for this person"
        placeholder="Only you see this name"
        size="xs"
        maxLength={80}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <Button
        size="xs"
        loading={save.isPending}
        onClick={() => save.mutate(text.trim())}
      >
        Save my name
      </Button>
      <Button size="xs" variant="subtle" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {save.error != null && (
        <Text size="xs" c="red">
          {errorMessage(save.error, true)}
        </Text>
      )}
    </Group>
  );
};

export default PersonLabelEditor;
