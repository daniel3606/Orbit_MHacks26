import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signedPct } from '../market/format.ts';
import { performanceReadout } from './readout.ts';

const latest = {
  latestPrice: 307.49,
  previousClose: 292.35,
  range: 'MAX',
  rangeBase: 144.48,
  rangeLatest: 307.49,
  scrub: null,
};

describe('stock price readout', () => {
  it('keeps the latest-session change constant while scrubbing', () => {
    const idle = performanceReadout(latest);
    const scrubbed = performanceReadout({ ...latest, scrub: { price: 157.07, date: '2026-03-25' } });
    assert.equal(scrubbed.latestSession?.text, idle.latestSession?.text);
    assert.equal(idle.latestSession?.text, `${signedPct(307.49 / 292.35 - 1)} latest session`);
    assert.match(idle.latestSession?.text ?? '', /latest session$/);
  });

  it('keeps the selected-range return constant while scrubbing', () => {
    const idle = performanceReadout(latest);
    const scrubbed = performanceReadout({ ...latest, scrub: { price: 157.07, date: '2026-03-25' } });
    assert.equal(scrubbed.rangeReturn?.text, idle.rangeReturn?.text);
    assert.equal(idle.rangeReturn?.text, `MAX ${signedPct(307.49 / 144.48 - 1)}`);
    assert.notEqual(idle.rangeReturn?.text, `MAX ${signedPct(157.07 / 144.48 - 1)}`);
  });

  it('updates the historical date and price while scrubbing', () => {
    const older = performanceReadout({ ...latest, scrub: { price: 157.07, date: '2026-03-25' } });
    const newer = performanceReadout({ ...latest, scrub: { price: 180.2, date: '2026-06-02' } });
    assert.equal(older.history?.date, 'Mar 25, 2026');
    assert.equal(older.price, 157.07);
    assert.equal(newer.history?.date, 'Jun 2, 2026');
    assert.equal(newer.price, 180.2);
  });

  it('restores the latest price when scrubbing stops', () => {
    const released = performanceReadout({ ...latest, scrub: null });
    assert.equal(released.price, 307.49);
    assert.equal(released.history, null);
  });

  it('labels a scrub percentage with its reference point', () => {
    const scrubbed = performanceReadout({ ...latest, scrub: { price: 157.07, date: '2026-03-25' } });
    const text = scrubbed.history?.fromStart?.text ?? '';
    assert.match(text, /from start of range$/);
    assert.match(text, /% from start of range$/);
    assert.doesNotMatch(text, /latest session/);
    assert.equal(scrubbed.history?.fromStart?.text, `${signedPct(157.07 / 144.48 - 1)} from start of range`);
  });
});
