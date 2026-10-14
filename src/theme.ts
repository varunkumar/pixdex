import { Badge, createTheme, type MantineColorsTuple } from '@mantine/core';

export const BRAND = 'PixdeX';

// Ten shades around the Aurora teal; index 6 is the primary shade in light mode.
const aurora: MantineColorsTuple = [
  '#E6FAFB',
  '#C9F2F5',
  '#9DE6EB',
  '#6DD8DF',
  '#3FC6CF',
  '#1FB2BD',
  '#0E8F9A',
  '#0B747D',
  '#085C64',
  '#05444A',
];

export const HEADER_GRADIENT = 'linear-gradient(100deg, #0E8F9A, #2563EB 55%, #7C3AED)';

export const theme = createTheme({
  primaryColor: 'aurora',
  colors: { aurora },
  fontFamily: "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  headings: {
    fontFamily: "'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif",
    fontWeight: '700',
  },
  defaultRadius: 'md',
  components: {
    // Tags and hashtags are shown as written (Mantine uppercases badges by default).
    Badge: Badge.extend({ defaultProps: { tt: 'none' } }),
  },
  defaultGradient: { from: '#0E8F9A', to: '#7C3AED', deg: 100 },
});
