/**
 * Orbit visual tokens.
 * Screen background is a vertical gradient; `background` is the top stop and
 * the solid color used behind headers, the splash, and navigation transitions.
 */
import { Platform } from 'react-native';

export const colors = {
  background: '#050308',
  backgroundMid: '#0A0710',
  backgroundEnd: '#150E22',
  surface: '#140C1C',
  surfaceRaised: '#1C1228',
  border: '#3A2450',
  text: '#E3E3E3',
  textMuted: '#A39AAD',
  /** Secondary figures on the trade ticket. */
  textSubtle: '#999999',
  /** The empty "$0" on the trade ticket, before anything is typed. */
  amountEmpty: '#2A2733',
  tabActive: '#FFFFFF',
  tabInactive: '#999999',
  accent: '#E8C872',
  accentText: '#1A1608',
  accentSoft: 'rgba(232, 200, 114, 0.14)',
  secondary: '#3B0F5F',
  secondaryText: '#E3E3E3',
  graphTop: '#000000',
  graphBottom: '#1F0457',
  graphLine: '#FFFFFF',
  info: '#8FB8FF',
  success: '#7FD8A6',
  warning: '#F2B36B',
  danger: '#FF8A8A',
  selection: '#2A1438',
  /** Selected chart range. */
  rangeActive: '#2F0C48',
} as const;

/** Top, middle, end. Applied as a vertical fill behind every screen. */
export const backgroundGradient = [colors.background, colors.backgroundMid, colors.backgroundEnd] as const;

/** Graph card fill. 30% opaque so the screen background shows through. */
export const graphFillOpacity = 0.3;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radius = { sm: 8, md: 12, lg: 18, xl: 22, pill: 999 } as const;

export const font = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
} as const;

export const type = {
  display: { fontFamily: font.bold, fontSize: 32, lineHeight: 38 },
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 30 },
  heading: { fontFamily: font.semibold, fontSize: 18, lineHeight: 24 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 22 },
  label: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18 },
  caption: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, lineHeight: 16 },
} as const;

/** Minimum touch target (Apple HIG). */
export const HIT = 44;
