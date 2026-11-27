import { Badge } from '@mantine/core';

/** The middle colour of the header gradient; white text on it is about 5:1, in both colour schemes. */
export const COVER_COLOR = '#2563EB';

/** "This is the cover", the same on album tiles, person tiles and a photo's face rows. */
const CoverBadge = () => (
  <Badge size="sm" variant="filled" color={COVER_COLOR} c="white">
    Cover
  </Badge>
);

export default CoverBadge;
