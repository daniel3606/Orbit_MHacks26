/**
 * Provisional celestial design tokens. No approved Figma reference was
 * available in this workspace; replace values here once frames are mapped.
 * Contrast pairs target WCAG AA on `background`/`surface`.
 */
import { Platform } from 'react-native';

export const colors = {
  background: '#0B1026', // deep night
  surface: '#141B3A',
  surfaceRaised: '#1C2550',
  border: '#2A356B',
  text: '#F4F1E8', // starlight
  textMuted: '#B4B9D6',
  accent: '#E8C872', // gold
  accentText: '#1A1608',
  accentSoft: 'rgba(232, 200, 114, 0.14)',
  info: '#8FB8FF',
  success: '#7FD8A6',
  warning: '#F2B36B',
  danger: '#FF8A8A',
  selection: '#2E3B7A',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

const serif = Platform.select({ ios: 'ui-serif', default: 'serif' });

export const type = {
  display: { fontFamily: serif, fontSize: 32, lineHeight: 38, fontWeight: '600' as const },
  title: { fontFamily: serif, fontSize: 24, lineHeight: 30, fontWeight: '600' as const },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, lineHeight: 16 },
} as const;

/** Minimum touch target (Apple HIG). */
export const HIT = 44;
