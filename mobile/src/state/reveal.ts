import { create } from 'zustand';

/**
 * The "Building your personal experience" screen shown after onboarding. It is
 * started on the questionnaire and drawn by the root layout, so it stays up
 * while the protected routes swap from onboarding to the tabs underneath it.
 */
type RevealStore = {
  active: boolean;
  sign: string | null;
  startedAt: number;
  begin: (sign: string | null) => void;
  end: () => void;
};

export const useReveal = create<RevealStore>(set => ({
  active: false,
  sign: null,
  startedAt: 0,
  begin: sign => set({ active: true, sign, startedAt: Date.now() }),
  end: () => set({ active: false }),
}));
