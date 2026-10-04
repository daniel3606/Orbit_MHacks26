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
import { daysInMonth, signForBirthday } from '@/features/onboarding/zodiac';

/**
 * Local, unsaved answers. Discarded after a successful save; the saved
 * profile only ever comes back through the SpacetimeDB subscription.
 * `birthMonth`/`birthDay` never leave the device: only the sign derived
 * from them is saved.
 */
export type Draft = {
  riskTolerance: string | null;
  investmentHorizon: string | null;
  investmentStyle: string | null;
  sectorInterests: string[];
  experienceLevel: string | null;
  primaryGoal: string | null;
  zodiacSign: string | null;
  birthMonth: number | null;
  birthDay: number | null;
};

const EMPTY: Draft = {
  riskTolerance: null,
  investmentHorizon: null,
  investmentStyle: null,
  sectorInterests: [],
  experienceLevel: null,
  primaryGoal: null,
  zodiacSign: null,
  birthMonth: null,
  birthDay: null,
};

type DraftStore = {
  draft: Draft;
  step: number;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  toggleSector: (value: string) => void;
  /** Sets either part of the birthday; the sign follows once both are known. */
  setBirthday: (part: { month?: number; day?: number }) => void;
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
  setBirthday: part =>
    set(s => {
      const birthMonth = part.month ?? s.draft.birthMonth;
      const day = part.day ?? s.draft.birthDay;
      // Switching to a shorter month drops a day it doesn't have (e.g. 31 → April).
      const birthDay = birthMonth !== null && day !== null && day > daysInMonth(birthMonth) ? null : day;
      const complete = birthMonth !== null && birthDay !== null;
      const wasComplete = s.draft.birthMonth !== null && s.draft.birthDay !== null;
      // A sign worked out from an earlier birthday no longer holds once the birthday is incomplete;
      // a sign loaded from the saved profile stays until a full birthday replaces it.
      const zodiacSign = complete ? signForBirthday(birthMonth, birthDay) : wasComplete ? null : s.draft.zodiacSign;
      return { draft: { ...s.draft, birthMonth, birthDay, zodiacSign } };
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
    birthMonth: null,
    birthDay: null,
  };
}

export type ValidDraft = Omit<Draft, 'birthMonth' | 'birthDay' | 'zodiacSign' | 'riskTolerance' | 'investmentHorizon' | 'investmentStyle' | 'experienceLevel' | 'primaryGoal'> & {
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
