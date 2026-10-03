import { create } from 'zustand';

/** Apple, until the person opens something else or clears the list. The published ticker is AAPL. */
const INITIAL_RECENTS = ['AAPL'];
const MAX_RECENTS = 12;

type RecentsStore = {
  tickers: string[];
  remember: (ticker: string) => void;
  clear: () => void;
};

export const useRecents = create<RecentsStore>(set => ({
  tickers: INITIAL_RECENTS,
  remember: ticker =>
    set(state => ({
      tickers: [ticker, ...state.tickers.filter(item => item !== ticker)].slice(0, MAX_RECENTS),
    })),
  clear: () => set({ tickers: [] }),
}));
