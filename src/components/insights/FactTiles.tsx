import { Card, Stack, Text, UnstyledButton } from '@mantine/core';
import { useHistoryState } from '../../hooks/useHistoryState';
import type { Fact } from '../../types/api';
import FactChart from './charts';
import { describeFact } from './factText';

/** One tile for each fact; the open one takes the full width and shows its headline, chart and note. */
const FactTiles = ({ facts }: { facts: Fact[] }) => {
  const [open, setOpen] = useHistoryState<string | null>('open-fact', null);
  return (
    <div className="pdx-facts">
      {facts.map((fact) => {
        const text = describeFact(fact);
        const expanded = open === fact.id;
        return (
          <Card key={fact.id} withBorder padding="sm" className="pdx-fact" data-open={expanded}>
            <UnstyledButton aria-expanded={expanded} onClick={() => setOpen(expanded ? null : fact.id)}>
              <Text size="xs" fw={700} c="var(--pixdex-ink-teal)">
                {text.label}
              </Text>
              <Text fz="xl" fw={700} lh={1.2} lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
                {text.value}
              </Text>
            </UnstyledButton>
            {expanded && (
              <Stack gap="xs" mt="sm">
                <Text fw={700}>{text.headline}</Text>
                {text.chart && <FactChart chart={text.chart} label={text.label} />}
                {text.note && (
                  <Text size="sm" c="dimmed">
                    {text.note}
                  </Text>
                )}
              </Stack>
            )}
          </Card>
        );
      })}
    </div>
  );
};

export default FactTiles;
