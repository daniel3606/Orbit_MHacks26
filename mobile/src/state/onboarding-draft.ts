import { create } from 'zustand';

import type { ProfileVM } from '@/realtime/connection';
import {
  EXPERIENCE_LEVEL,
  INVESTMENT_HORIZON,
  INVESTMENT_STYLE,
  MAX_SECTORS,
  PRIMARY_GOAL,
  RISK_TOLERANCE,
  SECTORS,
  ZODIAC_SIGNS,
  type Option,
} from '@/features/onboarding/options';

/**
 * Local, unsaved answers. Discarded after a successful save; the saved
 * profile only ever comes back through the SpacetimeDB subscription.
 */
export type Draft = {
  riskTolerance: string | null;
  investmentHorizon: string | null;
  investmentStyle: string | null;
  sectorInterests: string[];
  experienceLevel: string | null;
  primaryGoal: string | null;
  zodiacSign: string | null;
};

const EMPTY: Draft = {
  riskTolerance: null,
  investmentHorizon: null,
  investmentStyle: null,
  sectorInterests: [],
  experienceLevel: null,
  primaryGoal: null,
  zodiacSign: null,
};

type DraftStore = {
  draft: Draft;
  step: number;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  toggleSector: (value: string) => void;
  setStep: (step: number) => void;
  replace: (draft: Draft) => void;
  reset: () => void;
};

export const useDraft = create<DraftStore>(set => ({
  draft: EMPTY,
  step: 0,
  set: (key, value) => set(s => ({ draft: { ...s.draft, [key]: value } })),
  toggleSector: value =>
    set(s => {
      const has = s.draft.sectorInterests.includes(value);
      if (!has && s.draft.sectorInterests.length >= MAX_SECTORS) return s;
      const sectorInterests = has
        ? s.draft.sectorInterests.filter(v => v !== value)
        : [...s.draft.sectorInterests, value];
      return { draft: { ...s.draft, sectorInterests } };
    }),
  setStep: step => set({ step }),
  replace: draft => set({ step: 0, draft }),
  reset: () => set({ draft: EMPTY, step: 0 }),
}));

/** Draft prefilled from the committed, subscribed profile. */
export function draftFromProfile(profile: ProfileVM, zodiacSign: string | null): Draft {
  return {
    riskTolerance: profile.riskTolerance,
    investmentHorizon: profile.investmentHorizon,
    investmentStyle: profile.investmentStyle,
    sectorInterests: [...profile.sectorInterests],
    experienceLevel: profile.experienceLevel,
    primaryGoal: profile.primaryGoal,
    zodiacSign,
  };
}

export type ValidDraft = Omit<Draft, 'zodiacSign' | 'riskTolerance' | 'investmentHorizon' | 'investmentStyle' | 'experienceLevel' | 'primaryGoal'> & {
  riskTolerance: string;
  investmentHorizon: string;
  investmentStyle: string;
  experienceLevel: string;
  primaryGoal: string;
  zodiacSign: string | undefined;
};

const inSet = (options: Option[], v: string | null): v is string => v !== null && options.some(o => o.value === v);

/** Client-side check for UX only; the reducer is the authority. */
export function validateDraft(d: Draft): { ok: true; value: ValidDraft } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!inSet(RISK_TOLERANCE, d.riskTolerance)) missing.push('risk comfort');
  if (!inSet(INVESTMENT_HORIZON, d.investmentHorizon)) missing.push('time horizon');
  if (!inSet(INVESTMENT_STYLE, d.investmentStyle)) missing.push('investing style');
  if (d.sectorInterests.length < 1 || d.sectorInterests.length > MAX_SECTORS || !d.sectorInterests.every(s => inSet(SECTORS, s)))
    missing.push('sectors');
  if (!inSet(EXPERIENCE_LEVEL, d.experienceLevel)) missing.push('experience');
  if (!inSet(PRIMARY_GOAL, d.primaryGoal)) missing.push('goal');
  if (d.zodiacSign !== null && !inSet(ZODIAC_SIGNS, d.zodiacSign)) missing.push('sign');
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    value: {
      riskTolerance: d.riskTolerance!,
      investmentHorizon: d.investmentHorizon!,
      investmentStyle: d.investmentStyle!,
      sectorInterests: d.sectorInterests,
      experienceLevel: d.experienceLevel!,
      primaryGoal: d.primaryGoal!,
      zodiacSign: d.zodiacSign ?? undefined,
    },
  };
}
