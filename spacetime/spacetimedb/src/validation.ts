import { SenderError } from 'spacetimedb/server';
import {
  EXPERIENCE_LEVEL,
  INVESTMENT_HORIZON,
  INVESTMENT_STYLE,
  MAX_SECTORS,
  PRIMARY_GOAL,
  RISK_TOLERANCE,
  SECTORS,
  ZODIAC_SIGNS,
} from './preferences';

export type PreferenceInput = {
  riskTolerance: string;
  investmentHorizon: string;
  investmentStyle: string;
  sectorInterests: string[];
  experienceLevel: string;
  primaryGoal: string;
};

function requireOneOf(field: string, value: string, allowed: readonly string[]) {
  if (!allowed.includes(value)) {
    throw new SenderError(`invalid_${field}`);
  }
}

/** Validates and canonicalizes preferences. Throws a SenderError with a stable code. */
export function validatePreferences(input: PreferenceInput): PreferenceInput {
  requireOneOf('risk_tolerance', input.riskTolerance, RISK_TOLERANCE);
  requireOneOf('investment_horizon', input.investmentHorizon, INVESTMENT_HORIZON);
  requireOneOf('investment_style', input.investmentStyle, INVESTMENT_STYLE);
  requireOneOf('experience_level', input.experienceLevel, EXPERIENCE_LEVEL);
  requireOneOf('primary_goal', input.primaryGoal, PRIMARY_GOAL);

  const sectors = [...new Set(input.sectorInterests)];
  if (sectors.length !== input.sectorInterests.length) {
    throw new SenderError('invalid_sector_interests_duplicate');
  }
  if (sectors.length < 1 || sectors.length > MAX_SECTORS) {
    throw new SenderError('invalid_sector_interests_count');
  }
  for (const sector of sectors) requireOneOf('sector_interests', sector, SECTORS);
  // Canonical order keeps equal selections equal regardless of tap order.
  sectors.sort((a, b) => SECTORS.indexOf(a as never) - SECTORS.indexOf(b as never));

  return { ...input, sectorInterests: sectors };
}

export function validateZodiac(sign: string | undefined): string | undefined {
  if (sign === undefined) return undefined;
  requireOneOf('zodiac_sign', sign, ZODIAC_SIGNS);
  return sign;
}
