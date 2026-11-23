import { ActionIcon } from '@mantine/core';
import { TbLayoutColumns, TbRectangle } from 'react-icons/tb';
import { usePhoneColumns } from '../hooks/usePhoneColumns';

/** Phones only: switch the photo grid between 2 columns and 1 (remembered in this browser). */
const ColumnsToggle = () => {
  const [columns, toggle] = usePhoneColumns();
  return (
    <ActionIcon
      hiddenFrom="xs"
      variant="default"
      size={42}
      aria-label={columns === 2 ? 'Switch to 1 column' : 'Switch to 2 columns'}
      onClick={toggle}
    >
      {columns === 2 ? <TbRectangle size={22} aria-hidden /> : <TbLayoutColumns size={22} aria-hidden />}
    </ActionIcon>
  );
};

export default ColumnsToggle;
