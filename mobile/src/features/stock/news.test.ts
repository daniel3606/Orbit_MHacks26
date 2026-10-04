import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHECK_TIMEOUT_MS, CHECKING_NEWS, EMPTY_NEWS, newsSection, UNAVAILABLE_NEWS } from './news.ts';

const NOW = Date.UTC(2026, 9, 4, 15, 0);
const story = (headline: string, hoursAgo: number, url = `https://news.example/${hoursAgo}`) => ({
  headline,
  source: 'Reuters',
  url,
  publishedAt: new Date(NOW - hoursAgo * 3_600_000),
});

describe('stock detail news', () => {
  it('lists up to three stories with publisher, relative time and the original link', () => {
    const row = {
      stories: [story('Arm starts selling its own data-center CPU', 3), story('Arm wins a licensing deal', 30)],
      classification: 'classified',
      checkedAt: new Date(NOW),
    };
    const section = newsSection(row, null, NOW);
    assert.equal(section.kind, 'stories');
    if (section.kind !== 'stories') return;
    assert.deepEqual(
      section.stories.map(s => [s.headline, s.meta, s.url]),
      [
        ['Arm starts selling its own data-center CPU', 'Reuters · 3 h ago', 'https://news.example/3'],
        ['Arm wins a licensing deal', 'Reuters · 1 d ago', 'https://news.example/30'],
      ]
    );
    assert.match(section.stories[0]!.label, /Opens the story/);
  });

  it('never shows more than three stories or a non-https link', () => {
    const row = {
      stories: [story('A', 1), story('B', 2), story('C', 3), story('D', 4), story('Unsafe', 5, 'http://x.example')],
      classification: 'classified',
      checkedAt: new Date(NOW),
    };
    const section = newsSection(row, null, NOW);
    assert.equal(section.kind === 'stories' ? section.stories.length : 0, 3);
    const unsafeOnly = newsSection({ ...row, stories: [story('Unsafe', 5, 'http://x.example')] }, null, NOW);
    assert.deepEqual(unsafeOnly, { kind: 'empty', message: EMPTY_NEWS });
  });

  it('says plainly when nothing relevant survived', () => {
    const row = { stories: [], classification: 'classified', checkedAt: new Date(NOW) };
    assert.deepEqual(newsSection(row, null, NOW), { kind: 'empty', message: EMPTY_NEWS });
    assert.doesNotMatch(EMPTY_NEWS, /stored/i);
  });

  it('shows checking while a request is fresh, then that news is unavailable', () => {
    assert.deepEqual(newsSection(null, NOW - 1_000, NOW), { kind: 'checking', message: CHECKING_NEWS });
    assert.deepEqual(newsSection(null, NOW - CHECK_TIMEOUT_MS, NOW), { kind: 'unavailable', message: UNAVAILABLE_NEWS });
    assert.deepEqual(newsSection(null, null, NOW), { kind: 'unavailable', message: UNAVAILABLE_NEWS });
  });
});
