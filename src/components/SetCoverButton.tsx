import { ActionIcon, Tooltip } from '@mantine/core';
import { TbPhotoStar } from 'react-icons/tb';

/** The tile control that makes a photo the cover (album and person pages). */
const SetCoverButton = ({ label, loading, onClick }: { label: string; loading: boolean; onClick: () => void }) => (
  <Tooltip label="Set as cover">
    <ActionIcon
      variant="filled"
      color="dark"
      size="md"
      aria-label={`Set as cover: ${label}`}
      loading={loading}
      onClick={onClick}
    >
      <TbPhotoStar aria-hidden />
    </ActionIcon>
  </Tooltip>
);

export default SetCoverButton;
