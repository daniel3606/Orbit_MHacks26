/**
 * Birthday → sun sign. Only the month and day are asked for, and only the sign
 * leaves the device: the birthday itself is never saved or sent.
 */
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** February allows the 29th: there is no year, so a leap-day birthday must be pickable. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(month: number): number {
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/** Each sign with the last day it covers, in calendar order from January. */
const SIGN_ENDS: { sign: string; month: number; day: number }[] = [
  { sign: 'capricorn', month: 1, day: 19 },
  { sign: 'aquarius', month: 2, day: 18 },
  { sign: 'pisces', month: 3, day: 20 },
  { sign: 'aries', month: 4, day: 19 },
  { sign: 'taurus', month: 5, day: 20 },
  { sign: 'gemini', month: 6, day: 20 },
  { sign: 'cancer', month: 7, day: 22 },
  { sign: 'leo', month: 8, day: 22 },
  { sign: 'virgo', month: 9, day: 22 },
  { sign: 'libra', month: 10, day: 22 },
  { sign: 'scorpio', month: 11, day: 21 },
  { sign: 'sagittarius', month: 12, day: 21 },
];

/** `month` is 1–12. Returns a value from ZODIAC_SIGNS, or null for an impossible date. */
export function signForBirthday(month: number, day: number): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(month)) return null;
  const end = SIGN_ENDS.find(e => month < e.month || (month === e.month && day <= e.day));
  // After December 21 the year wraps back to Capricorn.
  return end?.sign ?? 'capricorn';
}
