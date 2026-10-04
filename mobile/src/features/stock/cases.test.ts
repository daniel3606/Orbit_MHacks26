import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stockAnalysis } from './cases.ts';

function line(start: number, end: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / (count - 1));
}

const quiet = {
  dayChange: null,
  trendScore: null,
  longerPoints: null,
  news: null,
} as const;

describe('stock analysis', () => {
  it('describes the past month when 1M is selected', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '1M',
      points: line(100, 110, 22),
      dayChange: 0.02,
      trendScore: null,
      longerPoints: null,
      news: null,
    });
    assert.match(analysis.strong, /TER is up 10\.0% over the past month and rose 2\.0% in the latest session/);
    assert.doesNotMatch(`${analysis.strong} ${analysis.watch}`, /126|six month|the close is/i);
    assert.equal(analysis.context, null);
  });

  it('describes the past six months when 6M is selected, with no extra context line', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '6M',
      points: line(100, 142.4, 127),
      ...quiet,
      dayChange: 0.08,
    });
    assert.match(analysis.strong, /TER is up 42\.4% over the past six months and rose 8\.0% in the latest session/);
    assert.equal(analysis.context, null);
    assert.doesNotMatch(`${analysis.strong} ${analysis.watch}`, /126 sessions|the close is up|0–100/);
  });

  it('puts a high Trend Score with what looks strong', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '6M',
      points: line(100, 142.4, 127),
      dayChange: 0.08,
      trendScore: 88.4,
      longerPoints: null,
      news: null,
    });
    assert.equal(analysis.trend?.side, 'strong');
    assert.equal(analysis.trend?.line, 'Trend Score 88/100 — Strong recent activity.');
    assert.equal(analysis.trend?.basis, 'Based on recent price movement and trading volume.');
    assert.doesNotMatch(analysis.trend?.line ?? '', /stronger half|chance of making money/);
  });

  it('puts a low Trend Score with what to watch', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '1M',
      points: line(100, 80, 22),
      dayChange: -0.03,
      trendScore: 22,
      longerPoints: null,
      news: null,
    });
    assert.match(analysis.watch, /TER is down 20\.0% over the past month/);
    assert.match(analysis.watch, /In the latest session, TER fell 3\.0%/);
    assert.doesNotMatch(analysis.watch, /previous high/);
    assert.equal(analysis.trend?.side, 'watch');
    assert.match(analysis.trend?.line ?? '', /Trend Score 22\/100 — Weak recent activity/);
    assert.doesNotMatch(analysis.strong, /six month/);
  });

  it('calls out a large drop in the selected period', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '6M',
      points: [100, 150, 99, 142],
      ...quiet,
      dayChange: 0.01,
    });
    assert.match(analysis.strong, /over the past six months/);
    assert.match(analysis.watch, /fell as much as 34\.0% from a previous high/);
    assert.match(analysis.watch, /large price swings/);
    assert.doesNotMatch(analysis.watch, /stretch|sessions/);
  });

  it('adds six-month context only beside a shorter chart', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '1M',
      points: line(100, 108, 22),
      dayChange: 0.01,
      trendScore: 70,
      longerPoints: [100, 150, 99, 142.4],
      news: null,
    });
    assert.match(analysis.strong, /past month/);
    assert.doesNotMatch(analysis.strong, /six month/);
    assert.doesNotMatch(analysis.watch, /six month/);
    assert.match(analysis.context ?? '', /up 42\.4% over the past six months/);
    assert.match(analysis.context ?? '', /34\.0%/);
  });

  it('stays on price and volume when no story is stored', () => {
    const analysis = stockAnalysis({
      symbol: 'AAPL',
      range: '1M',
      points: line(100, 110, 22),
      dayChange: 0.01,
      trendScore: 88,
      longerPoints: line(80, 120, 127),
      news: null,
    });
    const text = `${analysis.strong} ${analysis.watch} ${analysis.context} ${analysis.trend?.line}`;
    assert.equal(analysis.news, null);
    assert.doesNotMatch(text, /no news|headline|not connected/i);
  });

  it('quotes a stored story without calling it the cause of the move', () => {
    const analysis = stockAnalysis({
      symbol: 'TER',
      range: '1M',
      points: line(100, 110, 22),
      dayChange: 0.02,
      trendScore: 88,
      longerPoints: null,
      news: {
        headline: 'Teradyne raises its outlook',
        source: 'Reuters',
        url: 'https://example.com/ter',
      },
    });
    assert.equal(analysis.news?.line, 'Reuters: “Teradyne raises its outlook”');
    assert.equal(analysis.news?.url, 'https://example.com/ter');
    assert.doesNotMatch(analysis.strong, /Reuters|outlook|because|caused/);
    assert.doesNotMatch(analysis.watch, /Reuters|outlook|because|caused/);
  });
});
