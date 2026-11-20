import { Anchor, Badge, CloseButton, Group } from '@mantine/core';
import { Link } from 'react-router-dom';
import { inkColor, kindColor } from './chipStyle';

type Props = {
  label: string;
  kind: 'people' | 'known' | 'species';
  onClear: () => void;
  /** Optional link to the same filter across all albums. */
  href?: string;
};

/** The active album filter as a coloured chip with a clear button; known also carries a "known" text marker. */
export default function AlbumFilterChip({ label, kind, onClear, href }: Props) {
  const color = kindColor(kind === 'people' ? 'own' : kind);
  return (
    <Group gap="xs" wrap="wrap">
      <Badge
        variant="light"
        color={color}
        size="lg"
        tt="none"
        styles={{ label: { color: inkColor(color) } }}
        rightSection={<CloseButton size="xs" aria-label="Clear filter" onClick={onClear} />}
      >
        {label}
        {kind === 'known' && (
          <span style={{ marginLeft: 6, fontSize: '0.75em', opacity: 0.85 }}>known</span>
        )}
      </Badge>
      {href && (
        <Anchor component={Link} to={href} size="sm" aria-label={`View all photos of ${label}`}>
          View all photos of {label}
        </Anchor>
      )}
    </Group>
  );
}
