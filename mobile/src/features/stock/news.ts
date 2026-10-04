export type NewsStory = { headline: string; source: string; url: string; publishedAt: Date };
export type StockNewsRow = { stories: NewsStory[]; classification: string; checkedAt: Date };

export type NewsSection =
  | { kind: 'stories'; stories: { headline: string; meta: string; url: string; label: string }[] }
  | { kind: 'empty'; message: string }
  | { kind: 'checking'; message: string }
  | { kind: 'unavailable'; message: string };

/** Same wording as `ago` in market/format; kept here so this file runs under plain `node --test`. */
function ago(from: Date, now: number): string {
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** How long to show "checking" for a ticker with no stored news before saying it isn't available. */
export const CHECK_TIMEOUT_MS = 20_000;

export const EMPTY_NEWS = 'No recent relevant news found.';
export const CHECKING_NEWS = 'Checking recent news…';
export const UNAVAILABLE_NEWS = "Recent news isn't available right now.";

/**
 * What the Stock Detail News section shows. The server already chose up to three
 * stories it judged to be about this company; the app only lays them out.
 */
export function newsSection(row: StockNewsRow | null, askedAt: number | null, now: number): NewsSection {
  if (row) {
    const stories = row.stories
      .filter(story => /^https:\/\//i.test(story.url) && story.headline.trim().length > 0)
      .slice(0, 3)
      .map(story => {
        const source = story.source.trim() || 'News';
        const meta = `${source} · ${ago(story.publishedAt, now)}`;
        return { headline: story.headline, meta, url: story.url, label: `${story.headline}. ${meta}. Opens the story.` };
      });
    return stories.length > 0 ? { kind: 'stories', stories } : { kind: 'empty', message: EMPTY_NEWS };
  }
  if (askedAt !== null && now - askedAt < CHECK_TIMEOUT_MS) return { kind: 'checking', message: CHECKING_NEWS };
  return { kind: 'unavailable', message: UNAVAILABLE_NEWS };
}
