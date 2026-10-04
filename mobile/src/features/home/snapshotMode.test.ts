import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { quoteAsOf, snapshotMode } from './snapshotMode.ts';

const asOf = { NVDA: '2026-10-02T20:00:00+00:00' };

describe('snapshot density', () => {
  it('shows the full snapshot for the first question about a company', () => {
    assert.equal(
      snapshotMode({ tickers: ['NVDA'], previousTickers: null, asOf, previousAsOf: null }),
      'full',
    );
  });

  it('keeps a same-company follow-up compact', () => {
    assert.equal(
      snapshotMode({ tickers: ['NVDA'], previousTickers: ['NVDA'], asOf, previousAsOf: asOf }),
      'compact',
    );
  });

  it('shows the full snapshot again when the company changes', () => {
    assert.equal(
      snapshotMode({
        tickers: ['TSLA'],
        previousTickers: ['NVDA'],
        asOf: { TSLA: asOf.NVDA },
        previousAsOf: asOf,
      }),
      'full',
    );
  });

  it('shows the full snapshot when the quote timestamp changes', () => {
    assert.equal(
      snapshotMode({
        tickers: ['NVDA'],
        previousTickers: ['NVDA'],
        asOf: { NVDA: '2026-10-05T20:00:00+00:00' },
        previousAsOf: asOf,
      }),
      'full',
    );
  });

  it('reads the quote timestamp from citations', () => {
    const citations = JSON.stringify([{ id: 'quote:NVDA', as_of: asOf.NVDA }]);
    assert.deepEqual(quoteAsOf(citations, ['NVDA']), asOf);
  });
});
