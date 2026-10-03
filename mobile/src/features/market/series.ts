export type ClosePoint = { sessionDate: string; close: number };

/** Sessions drawn on a chart. Five closes read as a short constellation. */
const CHART_DAYS = 5;

/**
 * The last five daily closes, oldest first. The live price replaces the newest
 * close when it is a different print, so the window stays five points. Falls
 * back to previous close → price only when no history has been published.
 */
export function chartSeries(
  closes: ClosePoint[] | undefined,
  quote?: { price: number; previousClose: number } | null,
): number[] | undefined {
  const history = [...(closes ?? [])]
    .filter(point => point.close > 0 && point.sessionDate.length > 0)
    .sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0))
    .map(point => point.close);

  let window = history.slice(-CHART_DAYS);
  if (quote && quote.price > 0) {
    const last = window[window.length - 1];
    if (last == null || Math.abs(last - quote.price) > 0.005) {
      window = [...window.slice(-(CHART_DAYS - 1)), quote.price];
    }
  }

  if (window.length >= 2) return window;
  if (quote && quote.previousClose > 0 && quote.price > 0) return [quote.previousClose, quote.price];
  return undefined;
}
