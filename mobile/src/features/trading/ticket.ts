/** Keypad entry for a dollar amount. Kept as the typed string so "12." and "12.50" display as typed. */

export type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';

const MAX_WHOLE_DIGITS = 7;

export function pressKey(entry: string, key: Key): string {
  if (key === 'back') return entry.slice(0, -1);
  if (key === '.') return entry.includes('.') ? entry : `${entry || '0'}.`;
  const [whole, frac] = entry.split('.');
  if (frac !== undefined) return frac.length >= 2 ? entry : entry + key;
  if (whole === '0') return key;
  return whole.length >= MAX_WHOLE_DIGITS ? entry : entry + key;
}

export function entryCents(entry: string): number {
  if (!entry) return 0;
  const [whole, frac = ''] = entry.split('.');
  return Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
}

export function centsEntry(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** Quick-add buttons. Never grows past what the keypad could type. */
export function addCents(entry: string, cents: number): string {
  const next = entryCents(entry) + Math.round(cents);
  return next >= 10 ** MAX_WHOLE_DIGITS * 100 ? entry : centsEntry(next);
}

/** "$1,234.5" for "1234.5". Shows the entry as typed, with grouping. */
export function entryLabel(entry: string): string {
  const [whole, frac] = (entry || '0').split('.');
  const grouped = Number(whole || '0').toLocaleString('en-US');
  return frac === undefined ? `$${grouped}` : `$${grouped}.${frac}`;
}

/** "$100" or "$100.50": whole dollars drop the cents. */
export function centsLabel(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  const frac = cents % 100;
  return frac === 0 ? `$${whole}` : `$${whole}.${String(frac).padStart(2, '0')}`;
}

export function centsToMicros(cents: number): bigint {
  return BigInt(Math.round(cents)) * 10_000n;
}

export function microsToNumber(micros: string | null | undefined): number | null {
  if (!micros || !/^-?\d+$/.test(micros)) return null;
  return Number(micros) / 1_000_000;
}

export function clientOrderKey(): string {
  // Hermes on a device has no global crypto. This id only has to be unique.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(12);
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (random) random(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = 'orbit-';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
