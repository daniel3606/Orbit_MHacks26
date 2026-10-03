/**
 * Preference vocabulary, version 1. Import-free so the mobile contract check
 * can load it under plain Node. The mobile app keeps a labelled copy in
 * `mobile/src/features/onboarding/options.ts`; `mobile/scripts/check-contract.mts`
 * fails if the two drift apart.
 */
export const PROFILE_SCHEMA_VERSION = 1;

export const RISK_TOLERANCE = ['conservative', 'moderate', 'aggressive'] as const;
export const INVESTMENT_HORIZON = ['weeks', 'months', 'years'] as const;
export const INVESTMENT_STYLE = ['growth', 'value', 'income', 'balanced'] as const;
export const EXPERIENCE_LEVEL = ['new', 'some', 'experienced'] as const;
export const PRIMARY_GOAL = [
  'learn_basics',
  'grow_long_term',
  'generate_income',
  'follow_trends',
] as const;
export const SECTORS = [
  'technology',
  'healthcare',
  'financials',
  'consumer_discretionary',
  'consumer_staples',
  'energy',
  'industrials',
  'communication_services',
  'utilities',
  'real_estate',
  'materials',
] as const;
export const ZODIAC_SIGNS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
] as const;

export const MAX_SECTORS = 5;
