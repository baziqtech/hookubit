/**
 * Tour open/closed and which step — the textbook case for Zustand in this app.
 *
 * It is genuinely client-only: no server owns it, it must not go in the URL
 * (a tour step is not a place you link someone to), and it is read by two
 * components that are nowhere near each other in the tree — the sidebar's
 * "Product tour" button and the tour panel itself, which is mounted at the
 * shell. Lifting it would mean threading it through the whole layout.
 */
import { create } from 'zustand';
import { TOUR_STEPS } from './tour-content';
import { shouldAutoOpenTour, writeTourRecord } from './tour-storage';

interface TourState {
  open: boolean;
  step: number;
  /** True once auto-open has been evaluated, so it can never fire twice. */
  autoOpenChecked: boolean;

  /** Opened deliberately — from the help affordance. Always starts at step 1. */
  openTour: () => void;
  /** Considered once per session; opens only for someone with no stored record. */
  maybeAutoOpen: () => void;
  next: () => void;
  previous: () => void;
  goTo: (step: number) => void;
  /** Dismissed early. Recorded so it does not reappear unbidden. */
  skip: () => void;
  /** Reached the end. Recorded the same way, under a different reason. */
  complete: () => void;
}

export const useTourStore = create<TourState>((set, get) => ({
  open: false,
  step: 0,
  autoOpenChecked: false,

  openTour: () => set({ open: true, step: 0 }),

  maybeAutoOpen: () => {
    if (get().autoOpenChecked) return;
    set({ autoOpenChecked: true, open: shouldAutoOpenTour(), step: 0 });
  },

  next: () =>
    set((state) => ({ step: Math.min(state.step + 1, TOUR_STEPS.length - 1) })),
  previous: () => set((state) => ({ step: Math.max(state.step - 1, 0) })),
  goTo: (step) => set({ step: Math.max(0, Math.min(step, TOUR_STEPS.length - 1)) }),

  skip: () => {
    writeTourRecord('skipped');
    set({ open: false });
  },

  complete: () => {
    writeTourRecord('completed');
    set({ open: false });
  },
}));
