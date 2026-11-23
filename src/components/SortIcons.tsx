import { ActionIcon, Box, Menu, Tooltip } from '@mantine/core';
import { TbArrowsSort, TbCheck } from 'react-icons/tb';
import type { IconType } from 'react-icons';

interface SortOption<V extends string> {
  value: V;
  label: string;
  icon: IconType;
}

interface SortIconsProps<V extends string> {
  options: SortOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the single phone menu button. */
  label: string;
}

/** Sort as icons: a button group from the `xs` breakpoint up, one menu button on phones. */
function SortIcons<V extends string>({ options, value, onChange, label }: SortIconsProps<V>) {
  return (
    <>
      <ActionIcon.Group visibleFrom="xs">
        {options.map(({ value: v, label: optionLabel, icon: Icon }) => (
          <Tooltip key={v} label={optionLabel}>
            <ActionIcon
              variant={v === value ? 'light' : 'default'}
              size="lg"
              aria-label={optionLabel}
              aria-pressed={v === value}
              onClick={() => onChange(v)}
            >
              <Icon aria-hidden />
            </ActionIcon>
          </Tooltip>
        ))}
      </ActionIcon.Group>
      <Box hiddenFrom="xs">
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="default" size="lg" aria-label={label}>
              <TbArrowsSort aria-hidden />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {options.map(({ value: v, label: optionLabel }) => (
              <Menu.Item
                key={v}
                rightSection={v === value ? <TbCheck aria-hidden /> : null}
                onClick={() => onChange(v)}
              >
                {optionLabel}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Box>
    </>
  );
}

export default SortIcons;
