import {
  ActionIcon,
  AppShell,
  Burger,
  Button,
  Container,
  Group,
  NavLink,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { IconType } from 'react-icons';
import { MdAlbum, MdDarkMode, MdHome, MdLightMode, MdLogout, MdPhoto, MdSearch } from 'react-icons/md';
import { Link, Outlet, useMatch } from 'react-router-dom';
import { BRAND, HEADER_GRADIENT } from '../theme';

interface NavItem {
  to: string;
  label: string;
  icon: IconType;
  end: boolean;
}

const LINKS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: MdHome, end: true },
  { to: '/albums', label: 'Albums', icon: MdAlbum, end: false },
  { to: '/search', label: 'Search', icon: MdSearch, end: false },
  { to: '/daily', label: 'Daily Pick', icon: MdPhoto, end: false },
];

const HeaderLink = ({ to, label, icon: Icon, end }: NavItem) => {
  const active = useMatch({ path: to, end }) !== null;
  return (
    <Button
      component={Link}
      to={to}
      variant="subtle"
      color="white"
      size="compact-md"
      leftSection={<Icon />}
      aria-current={active ? 'page' : undefined}
      style={{ background: active ? 'rgba(255,255,255,0.22)' : undefined }}
    >
      {label}
    </Button>
  );
};

const DrawerLink = ({ to, label, icon: Icon, end, onNavigate }: NavItem & { onNavigate: () => void }) => {
  const active = useMatch({ path: to, end }) !== null;
  return (
    <NavLink
      component={Link}
      to={to}
      label={label}
      leftSection={<Icon />}
      active={active}
      onClick={onNavigate}
    />
  );
};

const Layout = () => {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { desktop: true, mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header style={{ background: HEADER_GRADIENT, border: 'none' }}>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              color="white"
              aria-label="Toggle navigation"
            />
            <Link
              to="/"
              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
            >
              <img src="/pixdex-icon.svg" alt="" width={32} height={32} />
              <Text
                fw={700}
                fz="xl"
                c="white"
                style={{ fontFamily: 'var(--mantine-font-family-headings)' }}
              >
                {BRAND}
              </Text>
            </Link>
            <Group gap={4} visibleFrom="sm" wrap="nowrap">
              {LINKS.map((item) => (
                <HeaderLink key={item.to} {...item} />
              ))}
            </Group>
          </Group>

          <Group gap="xs" wrap="nowrap">
            <ActionIcon
              variant="subtle"
              color="white"
              onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle colour scheme"
            >
              {scheme === 'dark' ? <MdLightMode /> : <MdDarkMode />}
            </ActionIcon>
            <Button
              component="a"
              href="/cdn-cgi/access/logout"
              variant="subtle"
              color="white"
              size="compact-md"
              leftSection={<MdLogout />}
              visibleFrom="sm"
            >
              Log out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        {LINKS.map((item) => (
          <DrawerLink key={item.to} {...item} onNavigate={close} />
        ))}
        <NavLink component="a" href="/cdn-cgi/access/logout" label="Log out" leftSection={<MdLogout />} />
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="xl" py="md">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
};

export default Layout;
