import { useSyncExternalStore } from 'react';

export const ELAPSED_TICK_INTERVAL_MS = 2 * 60 * 1000;

const listeners = new Set();
let currentNow = Date.now();
let intervalId = null;

function publishCurrentTime() {
  currentNow = Date.now();
  for (const listener of listeners) listener();
}

function startSharedClock() {
  if (intervalId !== null) return;
  currentNow = Date.now();
  intervalId = window.setInterval(publishCurrentTime, ELAPSED_TICK_INTERVAL_MS);
  window.addEventListener('focus', publishCurrentTime);
}

function stopSharedClock() {
  if (intervalId === null) return;
  window.clearInterval(intervalId);
  intervalId = null;
  window.removeEventListener('focus', publishCurrentTime);
}

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) startSharedClock();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopSharedClock();
  };
}

function subscribeDisabled() {
  return () => {};
}

function getSnapshot() {
  return currentNow;
}

export function useSharedElapsedTick(enabled) {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    getSnapshot,
    getSnapshot
  );
}
