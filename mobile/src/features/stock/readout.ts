import { signedPct } from '@/features/market/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Mar 25, 2026". Null when the value is not a session date. */
export function inspectionDate(isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function move(price: number | null, base: number | null): number | null {
  if (price == null || base == null || !(price > 0) || !(base > 0)) return null;
  return price / base - 1;
}

export type PerformanceReadout = {
  /** Latest quote, or the chart point under the finger. */
  price: number | null;
  /** Present only while a chart point is selected. */
  history: {
    date: string | null;
    /** Labeled so it cannot be read as the latest session. */
    fromStart: { text: string; fraction: number } | null;
  } | null;
  /** Latest completed session. Independent of the selected point. */
  latestSession: { text: string; fraction: number } | null;
  /** Start of the selected range through the latest point. Independent of the selected point. */
  rangeReturn: { text: string; fraction: number; range: string } | null;
};

export function performanceReadout(input: {
  latestPrice: number | null;
  previousClose: number | null;
  range: string | null;
  rangeBase: number | null;
  /** Last point on the selected chart, including the live print. Not the scrubbed point. */
  rangeLatest: number | null;
  scrub: { price: number; date: string | null } | null;
}): PerformanceReadout {
  const session = move(input.latestPrice, input.previousClose);
  const span = move(input.rangeLatest, input.rangeBase);
  const fromStart = input.scrub ? move(input.scrub.price, input.rangeBase) : null;
  return {
    price: input.scrub ? input.scrub.price : input.latestPrice,
    history: input.scrub
      ? {
          date: input.scrub.date ? inspectionDate(input.scrub.date) : null,
          fromStart: fromStart == null ? null : { text: `${signedPct(fromStart)} from start of range`, fraction: fromStart },
        }
      : null,
    latestSession: session == null ? null : { text: `${signedPct(session)} latest session`, fraction: session },
    rangeReturn:
      input.range && span != null ? { text: `${input.range} ${signedPct(span)}`, fraction: span, range: input.range } : null,
  };
}
