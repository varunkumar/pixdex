import { Button, Group, Text } from '@mantine/core';
import { useState } from 'react';

/**
 * "Are you sure?" in place, for destructive actions. Focus starts on Cancel (the safe choice) and Cancel hands it
 * back to the control that opened the question.
 */
const InlineConfirm = ({
  message,
  confirmLabel,
  loading = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  // Read during the first render, before Cancel takes the focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <Group gap="xs">
      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
        {message}
      </Text>
      <Button size="xs" color="red" loading={loading} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button
        size="xs"
        variant="subtle"
        autoFocus
        onClick={() => {
          onCancel();
          opener?.focus();
        }}
      >
        Cancel
      </Button>
    </Group>
  );
};

export default InlineConfirm;
