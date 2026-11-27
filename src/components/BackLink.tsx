import { Anchor } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** The one in-page way back: an arrow and the name of where it goes. */
const BackLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Anchor component={Link} to={to} size="sm" w="fit-content" className="pdx-target">
    ← {children}
  </Anchor>
);

export default BackLink;
