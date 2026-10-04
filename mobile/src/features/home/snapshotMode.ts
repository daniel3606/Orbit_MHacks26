/** Whether a chat answer should repeat the full company snapshot. */

export type SnapshotMode = 'full' | 'compact';

export function sameTickers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((ticker, index) => ticker === b[index]);
}

export function quoteAsOf(citations: string, tickers: string[]): Record<string, string> {
  const stamps: Record<string, string> = {};
  try {
    const parsed = JSON.parse(citations) as { id?: string; as_of?: string }[];
    if (!Array.isArray(parsed)) return stamps;
    for (const item of parsed) {
      const match = /^quote:([A-Za-z.]+)/.exec(item?.id ?? '');
      const ticker = match?.[1];
      if (ticker && tickers.includes(ticker) && item.as_of) stamps[ticker] = item.as_of;
    }
  } catch {
    return stamps;
  }
  return stamps;
}

/** Full on a new company or a newer quote. Compact when the same company is still current. */
export function snapshotMode(input: {
  tickers: string[];
  previousTickers: string[] | null;
  asOf: Record<string, string>;
  previousAsOf: Record<string, string> | null;
}): SnapshotMode {
  if (input.previousTickers == null || input.previousAsOf == null) return 'full';
  if (!sameTickers(input.tickers, input.previousTickers)) return 'full';
  const refreshed = input.tickers.some(ticker => {
    const next = input.asOf[ticker];
    const previous = input.previousAsOf?.[ticker];
    return Boolean(next && previous && next !== previous);
  });
  return refreshed ? 'full' : 'compact';
}
