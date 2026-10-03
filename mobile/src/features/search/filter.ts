/** A stock row the search field can match. Mirrors the published market catalog. */
export type Searchable = {
  ticker: string;
  name: string;
  industry: string;
  sector: string;
};

/**
 * Lower is a closer match. `-1` means the query does not match.
 * Ticker hits outrank name hits, which outrank industry and sector.
 */
export function rankMatch(stock: Searchable, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return -1;
  const ticker = stock.ticker.toLowerCase();
  const name = stock.name.toLowerCase();
  const industry = stock.industry.toLowerCase();
  const sector = stock.sector.toLowerCase();
  if (ticker === query) return 0;
  if (ticker.startsWith(query)) return 1;
  if (name.startsWith(query)) return 2;
  if (ticker.includes(query)) return 3;
  if (name.includes(query)) return 4;
  if (industry.includes(query) || sector.includes(query)) return 5;
  return -1;
}

/** Catalog order is kept within the same match rank. An empty query matches nothing. */
export function filterStocks<T extends Searchable>(stocks: readonly T[], rawQuery: string): T[] {
  return stocks
    .map((stock, index) => ({ stock, index, rank: rankMatch(stock, rawQuery) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.stock);
}
