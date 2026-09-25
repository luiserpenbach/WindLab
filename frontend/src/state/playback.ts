import { useSyncExternalStore } from 'react';

/**
 * Tiny external store for simulation playback. The 3D viewer subscribes
 * directly (no React re-render per animation frame); UI readouts use the hook.
 */
export interface PlaybackState {
  /** Current simulation time [s]. */
  t: number;
  /** Total duration [s]. */
  duration: number;
  playing: boolean;
  /** Playback speed multiplier. */
  speed: number;
}

type Listener = () => void;

let state: PlaybackState = { t: 0, duration: 0, playing: false, speed: 5 };
const listeners = new Set<Listener>();
let raf = 0;
let lastTs = 0;

function emit() {
  listeners.forEach((l) => l());
}

function tick(ts: number) {
  if (!state.playing) {
    raf = 0;
    return;
  }
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  let t = state.t + dt * state.speed;
  if (t >= state.duration) {
    t = state.duration;
    state = { ...state, t, playing: false };
    emit();
    raf = 0;
    return;
  }
  state = { ...state, t };
  emit();
  raf = requestAnimationFrame(tick);
}

export const playback = {
  get: (): PlaybackState => state,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  set(patch: Partial<PlaybackState>) {
    state = { ...state, ...patch };
    if (state.t > state.duration) state.t = state.duration;
    if (state.t < 0) state.t = 0;
    if (state.playing && !raf) {
      if (state.t >= state.duration) state.t = 0;
      lastTs = 0;
      raf = requestAnimationFrame(tick);
    }
    emit();
  },
  reset(duration: number) {
    state = { ...state, t: 0, duration, playing: false };
    emit();
  },
};

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(playback.subscribe, playback.get, playback.get);
}

/** Binary search: index of the last frame with t[i] <= time. */
export function frameIndexAt(t: number[], time: number): number {
  if (!t.length) return 0;
  let lo = 0;
  let hi = t.length - 1;
  if (time <= t[0]) return 0;
  if (time >= t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}
