import { ActionIcon, Box, Menu, Tooltip } from '@mantine/core';
import { TbArrowsSort, TbCheck } from 'react-icons/tb';
import type { IconType } from 'react-icons';

interface SortOption<V extends string> {
  value: V;
  label: string;
  /** An icon, or short bold `text` for a choice no icon draws legibly (A-Z). */
  icon?: IconType;
  text?: string;
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
      <ActionIcon.Group visibleFrom="xs" aria-label={label}>
        {options.map(({ value: v, label: optionLabel, icon: Icon, text }) => (
          <Tooltip key={v} label={optionLabel}>
            <ActionIcon
              variant={v === value ? 'light' : 'default'}
              size={42}
              aria-label={optionLabel}
              aria-pressed={v === value}
              onClick={() => onChange(v)}
            >
              {Icon ? (
                <Icon size={22} aria-hidden />
              ) : (
                <span aria-hidden style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.5 }}>
                  {text}
                </span>
              )}
            </ActionIcon>
          </Tooltip>
        ))}
      </ActionIcon.Group>
      <Box hiddenFrom="xs">
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="default" size={42} aria-label={`${label}, ${options.find((o) => o.value === value)?.label ?? ''}`}>
              <TbArrowsSort size={22} aria-hidden />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {options.map(({ value: v, label: optionLabel }) => (
              <Menu.Item
                key={v}
                // Mantine fixes the item role to "menuitem", so the current choice is part of its name.
                aria-label={v === value ? `${optionLabel} (current)` : optionLabel}
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
