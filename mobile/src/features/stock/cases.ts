import type { Range } from '@/features/market/series';

const FLAT = 0.0005;
/** A dip worth mentioning, still short of a large swing. */
const MENTION_DROP = 0.08;
/** Large enough to call out as a wide price swing. */
const LARGE_DROP = 0.15;

export type AnalysisNews = { headline: string; source: string; url: string };

export type StockAnalysis = {
  strong: string;
  watch: string;
  trend: { side: 'strong' | 'watch'; line: string; basis: string } | null;
  /** Set only for a chart shorter than six months, when that history exists. */
  context: string | null;
  news: { name: string; url: string; line: string } | null;
};

function percent(fraction: number): string {
  return `${Math.abs(fraction * 100).toFixed(1)}%`;
}

function pathStats(points: number[]): { change: number; drawdown: number } | null {
  const values = points.filter(value => value > 0 && Number.isFinite(value));
  if (values.length < 2) return null;
  let peak = values[0];
  let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    drawdown = Math.min(drawdown, value / peak - 1);
  }
  return { change: values[values.length - 1] / values[0] - 1, drawdown };
}

function periodPhrase(range: Range): string {
  switch (range) {
    case '1D':
      return 'today';
    case '5D':
      return 'the past five days';
    case '1M':
      return 'the past month';
    case '6M':
      return 'the past six months';
    case 'YTD':
      return 'this year';
    case '5Y':
      return 'the past five years';
    case 'MAX':
      return 'the period on the chart';
  }
}

function moveSentence(symbol: string, change: number, range: Range): string {
  const word = change >= 0 ? 'up' : 'down';
  const amount = percent(change);
  switch (range) {
    case '1D':
      return `${symbol} is ${word} ${amount} today.`;
    case 'YTD':
      return `${symbol} is ${word} ${amount} so far this year.`;
    case 'MAX':
      return `${symbol} is ${word} ${amount} across the period on the chart.`;
    default:
      return `${symbol} is ${word} ${amount} over ${periodPhrase(range)}.`;
  }
}

function dropSentence(symbol: string, drawdown: number): string | null {
  if (drawdown > -MENTION_DROP) return null;
  const swing = drawdown <= -LARGE_DROP ? ', showing that the stock has experienced large price swings' : '';
  return `During that same period, ${symbol} fell as much as ${percent(drawdown)} from a previous high${swing}.`;
}

function trendNote(score: number | null): StockAnalysis['trend'] {
  if (score == null || !Number.isFinite(score)) return null;
  const rounded = Math.round(score);
  const label = score >= 67 ? 'Strong recent activity' : score <= 40 ? 'Weak recent activity' : 'Mixed recent activity';
  return {
    side: score >= 67 ? 'strong' : 'watch',
    line: `Trend Score ${rounded}/100 — ${label}.`,
    basis: 'Based on recent price movement and trading volume.',
  };
}

function sixMonthContext(symbol: string, range: Range, longerPoints: number[] | null): string | null {
  if (range !== '1D' && range !== '5D' && range !== '1M') return null;
  const stats = longerPoints ? pathStats(longerPoints) : null;
  if (!stats) return null;
  const moved = Math.abs(stats.change) >= FLAT;
  const swung = stats.drawdown <= -LARGE_DROP;
  if (!moved && !swung) return null;
  const move = moved
    ? `${symbol} is ${stats.change >= 0 ? 'up' : 'down'} ${percent(stats.change)} over the past six months`
    : `${symbol} is about flat over the past six months`;
  if (swung) return `${move}, and fell as much as ${percent(stats.drawdown)} from a previous high.`;
  return `${move}.`;
}

function citedNews(news: AnalysisNews | null): StockAnalysis['news'] {
  if (!news) return null;
  const headline = news.headline.trim();
  const name = news.source.trim();
  if (!headline || !name || !/^https:\/\//i.test(news.url)) return null;
  return { name, url: news.url, line: `${name}: “${headline}”` };
}

/**
 * Plain-language notes for the chart range on screen. The six-month line is
 * separate, and only when that longer history is actually available.
 */
export function stockAnalysis(input: {
  symbol: string;
  range: Range;
  /** Prices drawn on the chart, oldest first. */
  points: number[];
  /** Change since the previous close. Omitted from the 1-day sentence, which already is that move. */
  dayChange: number | null;
  trendScore: number | null;
  longerPoints: number[] | null;
  news: AnalysisNews | null;
}): StockAnalysis {
  const stats = pathStats(input.points);
  const period = periodPhrase(input.range);
  const latest = input.range === '1D' || input.dayChange == null ? null : input.dayChange;
  const strong: string[] = [];
  const watch: string[] = [];

  if (stats && stats.change >= FLAT && latest != null && latest >= FLAT) {
    const amount = percent(stats.change);
    const day = percent(latest);
    if (input.range === 'YTD') strong.push(`${input.symbol} is up ${amount} so far this year and rose ${day} in the latest session.`);
    else if (input.range === 'MAX') {
      strong.push(`${input.symbol} is up ${amount} across the period on the chart and rose ${day} in the latest session.`);
    } else strong.push(`${input.symbol} is up ${amount} over ${period} and rose ${day} in the latest session.`);
  } else if (stats && stats.change >= FLAT) {
    strong.push(moveSentence(input.symbol, stats.change, input.range));
  } else if (latest != null && latest >= FLAT) {
    strong.push(`${input.symbol} rose ${percent(latest)} in the latest session.`);
  }

  if (stats && stats.change <= -FLAT) watch.push(moveSentence(input.symbol, stats.change, input.range));
  if (latest != null && latest <= -FLAT) watch.push(`In the latest session, ${input.symbol} fell ${percent(latest)}.`);
  // Skip a drop that is just the period's own decline, with no deeper dip along the way.
  if (stats && input.range !== '1D' && stats.drawdown < Math.min(0, stats.change) - 0.02) {
    const drop = dropSentence(input.symbol, stats.drawdown);
    if (drop) watch.push(drop);
  }

  if (strong.length === 0) {
    strong.push(
      stats
        ? `The price did not rise ${input.range === '1D' ? 'today' : `over ${period}`}.`
        : `There isn’t enough price history yet to describe ${input.symbol}.`,
    );
  }
  if (watch.length === 0) {
    watch.push(input.range === '1D' ? 'Nothing else in today’s price stands out.' : `No large drop shows up over ${period}.`);
  }

  return {
    strong: strong.join(' '),
    watch: watch.join(' '),
    trend: trendNote(input.trendScore),
    context: sixMonthContext(input.symbol, input.range, input.longerPoints),
    news: citedNews(input.news),
  };
}
