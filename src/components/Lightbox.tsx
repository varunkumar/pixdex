import { Anchor, Center, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import type { PrefetchStatus } from '../hooks/usePrefetchImage';

interface Props {
  opened: boolean;
  onClose: () => void;
  thumbnailSrc: string;
  /** Image URL of the original, or null when it cannot be shown inline (Drive). */
  originalSrc: string | null;
  originalStatus: PrefetchStatus;
  alt: string;
  /** Where the full original can be opened when it cannot be shown inline. */
  fallbackHref: string | null;
}

const Lightbox = ({ opened, onClose, thumbnailSrc, originalSrc, originalStatus, alt, fallbackHref }: Props) => {
  const showOriginal = originalSrc !== null && originalStatus === 'ready';
  const unavailable = originalSrc === null || originalStatus === 'error';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      title={alt}
      styles={{ content: { background: '#000' }, header: { background: '#000' }, title: { color: '#fff' } }}
    >
      <Stack align="center" gap="sm">
        <Image
          src={showOriginal ? originalSrc : thumbnailSrc}
          alt={alt}
          fit="contain"
          mah="calc(100vh - 140px)"
          maw="100%"
        />
        {originalSrc !== null && originalStatus === 'loading' && (
          <Center>
            <Loader size="sm" color="white" />
          </Center>
        )}
        {unavailable && (
          <Text c="gray.4" size="sm">
            {originalStatus === 'error'
              ? 'The original is unavailable right now (the machine hosting it may be offline).'
              : 'The original cannot be shown here.'}{' '}
            {fallbackHref && (
              <Anchor href={fallbackHref} target="_blank" rel="noopener noreferrer" c="aurora.3">
                Open original
              </Anchor>
            )}
          </Text>
        )}
      </Stack>
    </Modal>
  );
};

export default Lightbox;
