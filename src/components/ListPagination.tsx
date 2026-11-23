import { Group, Pagination, Select, Text } from '@mantine/core';
import { useEffect } from 'react';

interface Props {
  page: number;
  size: number;
  total: number;
  sizes: readonly number[];
  /** False while `total` still belongs to a previous query (placeholder data). */
  settled?: boolean;
  /** More items exist beyond `total` (not loaded yet): shows "N+" and keeps a next page available. */
  hasMore?: boolean;
  onPage: (page: number, replace?: boolean) => void;
  onSize: (size: number) => void;
}

const ListPagination = ({ page, size, total, sizes, settled = true, hasMore = false, onPage, onSize }: Props) => {
  const pages = Math.max(1, Math.ceil((total + (hasMore ? 1 : 0)) / size));

  // A stale or hand-edited URL can point past the last page: land on the last one.
  useEffect(() => {
    if (settled && total > 0 && page > pages) onPage(pages, true);
  }, [settled, total, page, pages, onPage]);

  if (total === 0) return null;

  const current = Math.min(page, pages);
  const from = (current - 1) * size + 1;
  const to = Math.min(current * size, total);
  const range = from > total ? 'Loading...' : `Showing ${from}-${to} of ${total}${hasMore ? '+' : ''}`;

  return (
    <Group justify="space-between" gap="md">
      <Text size="sm" c="dimmed">
        {range}
      </Text>
      <Pagination total={pages} value={current} onChange={(p) => onPage(p)} />
      <Select
        aria-label="Results per page"
        data={sizes.map(String)}
        value={String(size)}
        onChange={(value) => value && onSize(Number(value))}
        allowDeselect={false}
        w={90}
      />
    </Group>
  );
};

export default ListPagination;
