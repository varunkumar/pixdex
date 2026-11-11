import { Avatar, Tooltip } from '@mantine/core';
import { avatarColor, avatarInitials } from './avatarUtils';

interface UserAvatarProps {
  email: string;
  size?: number | string;
  /** Show the email in a tooltip (default true). */
  tooltip?: boolean;
}

/** Initials avatar derived from an email. Drawn locally: no email is sent to a third party. */
export const UserAvatar = ({ email, size = 'md', tooltip = true }: UserAvatarProps) => {
  const avatar = (
    <Avatar size={size} radius="xl" color={avatarColor(email)} variant="filled" aria-label={email}>
      {avatarInitials(email)}
    </Avatar>
  );
  return tooltip ? <Tooltip label={email}>{avatar}</Tooltip> : avatar;
};

/** Overlapping avatars, at most `max` shown plus a "+N" bubble. */
export const AvatarStack = ({ emails, max = 3, size = 'sm' }: { emails: string[]; max?: number; size?: number | string }) => {
  if (emails.length === 0) return null;
  const shown = emails.slice(0, max);
  const extra = emails.length - shown.length;
  return (
    <Tooltip.Group>
      <Avatar.Group spacing="xs">
        {shown.map((e) => (
          <UserAvatar key={e} email={e} size={size} />
        ))}
        {extra > 0 && (
          <Tooltip label={emails.slice(max).join(', ')}>
            <Avatar size={size} radius="xl">
              +{extra}
            </Avatar>
          </Tooltip>
        )}
      </Avatar.Group>
    </Tooltip.Group>
  );
};
