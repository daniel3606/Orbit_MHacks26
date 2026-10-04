import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { nextWatchlist } from '@/features/watchlist/list';

const KEY = 'orbit.watchlist';
const MAX = 50;

type WatchlistStore = {
  ready: boolean;
  tickers: string[];
  load: () => Promise<void>;
  toggle: (ticker: string) => void;
};

function remember(tickers: string[]) {
  void SecureStore.setItemAsync(KEY, JSON.stringify(tickers)).catch(() => {
    // The list stays in memory for this session if the device store is unavailable.
  });
}

let loading: Promise<void> | null = null;

export const useWatchlist = create<WatchlistStore>((set, get) => ({
  ready: false,
  tickers: [],
  load: () => {
    if (get().ready) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        const tickers = Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string' && /^[A-Z][A-Z0-9.]{0,9}$/.test(item)).slice(0, MAX)
          : [];
        set({ ready: true, tickers });
      } catch {
        set({ ready: true });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  toggle: ticker => {
    const tickers = nextWatchlist(get().tickers, ticker);
    set({ tickers });
    remember(tickers);
  },
}));
