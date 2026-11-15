import { useCallback, useState } from 'react';

/*
 * The sidebar's width, whether it is hidden, and which groups are folded away,
 * remembered on this device. Storage can be unavailable (private browsing,
 * full disk), so every read and write falls back quietly to the defaults.
 */
export const SIDEBAR = { min: 200, max: 380, default: 232, step: 16 };
const KEY = { width: 'connected.sidebar.width', hidden: 'connected.sidebar.hidden', collapsed: 'connected.sidebar.collapsed' };

const read = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered; still works this session */ }
};
// A fresh sign-in starts with only Teaching open; folding is remembered from then on.
const SIGN_IN_FOLDED = ['Results', 'Insights', 'Administration', 'You'];

/** Called on sign-in: forget the previous session's folding, so the defaults above apply. */
export function resetSidebarGroups() {
  write(KEY.collapsed, SIGN_IN_FOLDED);
}

const clamp = (w) => Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, Number(w) || SIDEBAR.default)));

export function useSidebar() {
  const [width, setWidthState] = useState(() => clamp(read(KEY.width, SIDEBAR.default)));
  const [hidden, setHiddenState] = useState(() => Boolean(read(KEY.hidden, false)));
  const [collapsed, setCollapsedState] = useState(() => new Set(read(KEY.collapsed, SIGN_IN_FOLDED)));

  /** persist=false while dragging, so storage is written once when the drag ends. */
  const setWidth = useCallback((w, persist = true) => {
    const next = clamp(w);
    setWidthState(next);
    if (persist) write(KEY.width, next);
  }, []);
  const setHidden = useCallback((h) => {
    setHiddenState(h);
    write(KEY.hidden, h);
  }, []);
  const setGroupOpen = useCallback((group, open) => {
    setCollapsedState((prev) => {
      if (open === !prev.has(group)) return prev;
      const next = new Set(prev);
      if (open) next.delete(group); else next.add(group);
      write(KEY.collapsed, [...next]);
      return next;
    });
  }, []);

  return { width, setWidth, hidden, setHidden, collapsed, setGroupOpen };
}
