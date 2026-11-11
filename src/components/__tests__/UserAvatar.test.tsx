import { describe, expect, it } from 'vitest';
import { avatarColor, avatarInitials } from '../avatarUtils';

describe('UserAvatar helpers', () => {
  it('derives initials from the local part', () => {
    expect(avatarInitials('jane.doe@example.com')).toBe('JD');
    expect(avatarInitials('varun@example.com')).toBe('V');
  });
  it('gives a stable colour, case-insensitive', () => {
    expect(avatarColor('A@x.com')).toBe(avatarColor('a@x.com'));
  });
});
