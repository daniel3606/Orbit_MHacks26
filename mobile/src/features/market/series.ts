export type ClosePoint = { sessionDate: string; close: number };

/** Sessions drawn on a chart. Five closes read as a short constellation. */
const CHART_DAYS = 5;

function sortedCloses(closes: ClosePoint[] | undefined): ClosePoint[] {
  return [...(closes ?? [])]
    .filter(point => point.close > 0 && point.sessionDate.length > 0)
    .sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
}

type TaggedClose = { close: number; date: string | null };

/** The live price replaces the newest close when it is a different print, so the window keeps its length. */
function withLive(window: number[], size: number, quote?: { price: number } | null): number[] {
  return withLiveDated(
    window.map(close => ({ close, date: null })),
    size,
    quote,
  ).map(point => point.close);
}

function withLiveDated(window: TaggedClose[], size: number, quote?: { price: number } | null): TaggedClose[] {
  if (!quote || quote.price <= 0) return window;
  const last = window[window.length - 1];
  if (last != null && Math.abs(last.close - quote.price) <= 0.005) return window;
  return [...window.slice(-(size - 1)), { close: quote.price, date: null }];
}

/**
 * The last five daily closes, oldest first. The live price replaces the newest
 * close when it is a different print, so the window stays five points. Falls
 * back to previous close → price only when no history has been published.
 */
export function chartSeries(
  closes: ClosePoint[] | undefined,
  quote?: { price: number; previousClose: number } | null,
): number[] | undefined {
  const history = sortedCloses(closes).map(point => point.close);
  const window = withLive(history.slice(-CHART_DAYS), CHART_DAYS, quote);

  if (window.length >= 2) return window;
  if (quote && quote.previousClose > 0 && quote.price > 0) return [quote.previousClose, quote.price];
  return undefined;
}

/** Daily-close ranges the Daily Brief can draw. Intraday 1D is not published. */
export const BRIEF_RANGES = ['1W', '1M', '3M', '1Y'] as const;
export type BriefRange = (typeof BRIEF_RANGES)[number];

const BRIEF_SESSIONS: Record<BriefRange, number> = { '1W': 5, '1M': 21, '3M': 63, '1Y': 252 };
/** Below this, the chip stays hidden instead of pretending the range is complete. */
const BRIEF_MINIMUM: Record<BriefRange, number> = { '1W': 2, '1M': 10, '3M': 40, '1Y': 180 };

export type DatedClose = { sessionDate: string; close: number };

function etDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Real completed closes for one Daily Brief range, oldest first.
 * A later quote print is included only when its New York date is the last
 * session or a newer one. Missing history returns null.
 */
export function briefSeries(
  range: BriefRange,
  closes: ClosePoint[] | undefined,
  quote?: { price: number; providerTime?: Date } | null,
): DatedClose[] | null {
  const history = sortedCloses(closes);
  if (history.length < BRIEF_MINIMUM[range]) return null;
  const points: DatedClose[] = history.slice(-BRIEF_SESSIONS[range]).map(point => ({
    sessionDate: point.sessionDate,
    close: point.close,
  }));
  if (quote && quote.price > 0 && quote.providerTime && points.length > 0) {
    const day = etDay(quote.providerTime);
    const last = points[points.length - 1];
    if (day === last.sessionDate) points[points.length - 1] = { sessionDate: day, close: quote.price };
    else if (day > last.sessionDate) points.push({ sessionDate: day, close: quote.price });
  }
  return points.length >= 2 ? points : null;
}

export function briefRangeAvailable(
  range: BriefRange,
  closes: ClosePoint[] | undefined,
  quote?: { price: number; providerTime?: Date } | null,
): boolean {
  return briefSeries(range, closes, quote) !== null;
}

/** Change from the first point to the last. Null when the series cannot support it. */
export function seriesReturn(points: DatedClose[] | null): number | null {
  if (!points || points.length < 2) return null;
  const base = points[0].close;
  const last = points[points.length - 1].close;
  if (!(base > 0) || !Number.isFinite(last)) return null;
  return last / base - 1;
}

export const RANGES = ['1D', '5D', '1M', '6M', 'YTD', '5Y', 'MAX'] as const;
export type Range = (typeof RANGES)[number];

/** Completed sessions each range needs. YTD is measured by date instead. */
const RANGE_SESSIONS: Record<Exclude<Range, '1D' | 'YTD' | 'MAX'>, number> = {
  '5D': 5,
  '1M': 21,
  '6M': 126,
  '5Y': 1260,
};

export type RangeSeries = {
  /** Prices, oldest first. */
  points: number[];
  /** Session date for each price. Null is the live print, which has no session close yet. */
  dates: (string | null)[];
  /** Price the change is measured from. */
  base: number;
};

/**
 * Prices for one chart range, or null when the published history does not
 * reach back that far. A range is never padded or stretched to look complete.
 */
export function rangeSeries(
  range: Range,
  closes: ClosePoint[] | undefined,
  quote?: { price: number; previousClose: number } | null,
  now = new Date(),
): RangeSeries | null {
  if (range === '1D') {
    if (!quote || quote.price <= 0 || quote.previousClose <= 0) return null;
    return {
      points: [quote.previousClose, quote.price],
      dates: [null, null],
      base: quote.previousClose,
    };
  }

  const history = sortedCloses(closes);
  let picked: ClosePoint[];
  if (range === 'MAX') {
    picked = history;
  } else if (range === 'YTD') {
    const year = String(now.getFullYear());
    // History has to start before this year, or the first session of the year is missing.
    if (history.length === 0 || history[0].sessionDate.slice(0, 4) >= year) return null;
    const before = history.filter(point => point.sessionDate.slice(0, 4) < year);
    picked = [before[before.length - 1], ...history.filter(point => point.sessionDate.slice(0, 4) >= year)];
  } else {
    const sessions = RANGE_SESSIONS[range];
    // One extra close is the starting price for the change.
    if (history.length < sessions + 1) return null;
    picked = history.slice(-(sessions + 1));
  }

  const dated = picked.map(point => ({ close: point.close, date: point.sessionDate }));
  const window =
    range === 'MAX' ? withLiveDated(dated, dated.length + 1, quote) : withLiveDated(dated, dated.length, quote);
  if (window.length < 2) return null;
  return {
    points: window.map(point => point.close),
    dates: window.map(point => point.date),
    base: window[0].close,
  };
}

/** The chart opens on the longest range that has real session closes. 1D is only two prices. */
const OPEN_ON: Range[] = ['6M', '1M', '5D', 'YTD', 'MAX', '1D'];

export function preferredRange(
  closes: ClosePoint[] | undefined,
  quote?: { price: number; previousClose: number } | null,
  now = new Date(),
): Range {
  for (const candidate of OPEN_ON) {
    if (rangeSeries(candidate, closes, quote, now)) return candidate;
  }
  return '1D';
}
