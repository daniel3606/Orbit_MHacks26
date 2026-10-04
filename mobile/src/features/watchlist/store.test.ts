import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextWatchlist } from './list.ts';

describe('watchlist', () => {
  it('adds a ticker at the front', () => {
    assert.deepEqual(nextWatchlist(['MSFT'], 'aapl'), ['AAPL', 'MSFT']);
  });

  it('removes a ticker that is already saved', () => {
    assert.deepEqual(nextWatchlist(['AAPL', 'MSFT'], 'AAPL'), ['MSFT']);
  });

  it('ignores a ticker that is not a symbol', () => {
    assert.deepEqual(nextWatchlist(['AAPL'], 'not a stock'), ['AAPL']);
  });
});
