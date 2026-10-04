const MAX = 50;

export function nextWatchlist(tickers: readonly string[], ticker: string): string[] {
  const symbol = ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return [...tickers];
  if (tickers.includes(symbol)) return tickers.filter(item => item !== symbol);
  return [symbol, ...tickers.filter(item => item !== symbol)].slice(0, MAX);
}
