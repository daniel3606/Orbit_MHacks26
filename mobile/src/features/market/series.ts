export type ClosePoint = { sessionDate: string; close: number };

/** Sessions drawn on a chart. Five closes read as a short constellation. */
const CHART_DAYS = 5;

function sortedCloses(closes: ClosePoint[] | undefined): ClosePoint[] {
  return [...(closes ?? [])]
    .filter(point => point.close > 0 && point.sessionDate.length > 0)
    .sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
}

/** The live price replaces the newest close when it is a different print, so the window keeps its length. */
function withLive(window: number[], size: number, quote?: { price: number } | null): number[] {
  if (!quote || quote.price <= 0) return window;
  const last = window[window.length - 1];
  if (last != null && Math.abs(last - quote.price) <= 0.005) return window;
  return [...window.slice(-(size - 1)), quote.price];
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
  /** Price the change is measured from. */
  base: number;
  /** Reads after the change figure, e.g. "Past month". */
  label: string;
};

function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

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
    return { points: [quote.previousClose, quote.price], base: quote.previousClose, label: 'Today' };
  }

  const history = sortedCloses(closes);
  let picked: ClosePoint[];
  let label: string;
  if (range === 'MAX') {
    picked = history;
    label = history.length > 0 ? `Since ${shortDate(history[0].sessionDate)}` : '';
  } else if (range === 'YTD') {
    const year = String(now.getFullYear());
    // History has to start before this year, or the first session of the year is missing.
    if (history.length === 0 || history[0].sessionDate.slice(0, 4) >= year) return null;
    const before = history.filter(point => point.sessionDate.slice(0, 4) < year);
    picked = [before[before.length - 1], ...history.filter(point => point.sessionDate.slice(0, 4) >= year)];
    label = 'Year to date';
  } else {
    const sessions = RANGE_SESSIONS[range];
    // One extra close is the starting price for the change.
    if (history.length < sessions + 1) return null;
    picked = history.slice(-(sessions + 1));
    label = { '5D': 'Past 5 days', '1M': 'Past month', '6M': 'Past 6 months', '5Y': 'Past 5 years' }[range];
  }

  const closesOnly = picked.map(point => point.close);
  const points = range === 'MAX' ? withLive(closesOnly, closesOnly.length + 1, quote) : withLive(closesOnly, closesOnly.length, quote);
  if (points.length < 2) return null;
  return { points, base: points[0], label };
}
