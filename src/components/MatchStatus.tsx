import { Group, Loader, Paper, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useMatchQueue } from '../hooks/useMatchQueue';

/** Small progress card for background matching, shown on every page while it runs. */
const MatchStatus = () => {
  const { current, waiting } = useMatchQueue();
  const busy = current !== null;

  // Matching is driven by this tab: ask before closing it midway.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  if (!current) return null;
  return (
    <Paper withBorder shadow="md" p="xs" pos="fixed" bottom={16} left={16} maw="calc(100vw - 32px)" style={{ zIndex: 200 }}>
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" />
        <Text size="xs" role="status">
          Looking for more matches... scanned {current.scanned}, matched {current.matched}
          {waiting.length > 0 && ` (${waiting.length} more waiting)`}
        </Text>
      </Group>
    </Paper>
  );
};

export default MatchStatus;
