'use client';
import { useSyncExternalStore } from 'react';
import { loadSession, onSessionChange, type Session } from './session';

/** The current session's role (null without a usable session), live across tabs. SSR renders null. */
export function useSessionRole(): Session['role'] | null {
  return useSyncExternalStore(
    onSessionChange,
    () => loadSession()?.role ?? null,
    () => null,
  );
}
