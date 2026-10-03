/**
 * Labelled preference vocabulary (v1). Values must match
 * spacetime/spacetimedb/src/preferences.ts — `npm run check:contract` enforces it.
 * Copy is provisional until the Figma onboarding frames are mapped.
 */
export type Option = { value: string; label: string; description?: string };

export const RISK_TOLERANCE: Option[] = [
  { value: 'conservative', label: 'Steady', description: 'I prefer smaller swings, even if growth is slower.' },
  { value: 'moderate', label: 'Balanced', description: 'Some ups and downs are fine for reasonable growth.' },
  { value: 'aggressive', label: 'Adventurous', description: 'I can accept big swings while I learn.' },
];

export const INVESTMENT_HORIZON: Option[] = [
  { value: 'weeks', label: 'Weeks', description: 'Short-term practice and following news.' },
  { value: 'months', label: 'Months', description: 'A season or two.' },
  { value: 'years', label: 'Years', description: 'Long-term learning and growth.' },
];

export const INVESTMENT_STYLE: Option[] = [
  { value: 'growth', label: 'Growth', description: 'Companies expanding quickly.' },
  { value: 'value', label: 'Value', description: 'Companies that may be priced below their fundamentals.' },
  { value: 'income', label: 'Income', description: 'Companies known for paying dividends.' },
  { value: 'balanced', label: 'Balanced', description: 'A mix of the above.' },
];

export const SECTORS: Option[] = [
  { value: 'technology', label: 'Technology' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'financials', label: 'Financials' },
  { value: 'consumer_discretionary', label: 'Consumer (discretionary)' },
  { value: 'consumer_staples', label: 'Consumer (staples)' },
  { value: 'energy', label: 'Energy' },
  { value: 'industrials', label: 'Industrials' },
  { value: 'communication_services', label: 'Communication services' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'real_estate', label: 'Real estate' },
  { value: 'materials', label: 'Materials' },
];

export const EXPERIENCE_LEVEL: Option[] = [
  { value: 'new', label: 'Brand new', description: "I haven't invested before." },
  { value: 'some', label: 'A little', description: "I've tried it or read about it." },
  { value: 'experienced', label: 'Experienced', description: 'I invest regularly.' },
];

export const PRIMARY_GOAL: Option[] = [
  { value: 'learn_basics', label: 'Learn the basics' },
  { value: 'grow_long_term', label: 'Grow money over time' },
  { value: 'generate_income', label: 'Understand income investing' },
  { value: 'follow_trends', label: 'Follow what’s moving' },
];

/** Branding only — never used for scoring, filtering, or ranking. */
export const ZODIAC_SIGNS: Option[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

export const MAX_SECTORS = 5;

export function labelFor(options: Option[], value: string | null | undefined): string {
  return options.find(o => o.value === value)?.label ?? (value || '—');
}
