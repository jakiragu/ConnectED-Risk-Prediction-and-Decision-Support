import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '../api/graphql.js';
import { ANGAZA_CLIENT_ID, refresh } from '../auth/cognito.jsx';

/**
 * The Angaza console's session. It is kept apart from the school app's session
 * (AuthContext) on purpose: different storage key, different sign-in pool,
 * different API client. Someone who is both an Angaza colleague and, say, a
 * test teacher can be signed in to both, and neither token is ever sent for
 * the other.
 */
const AngazaAuthContext = createContext(null);
const KEY = 'connected.angaza.session';

const decode = (token) => {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
};

const load = () => {
  try {
    const stored = localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

/** Expiry by this device's clock: the token's lifetime counted from when it arrived (see AuthContext). */
const expiresAt = (s) => {
  const c = decode(s?.idToken) || {};
  if (s?.obtainedAt && c.exp && c.iat) return s.obtainedAt + (c.exp - c.iat) * 1000;
  return (c.exp || 0) * 1000;
};

export function AngazaAuthProvider({ children }) {
  const [session, setSession] = useState(load);
  const current = useRef(session);
  const renewing = useRef(null);

  const save = (next, remember = localStorage.getItem(KEY) !== null) => {
    const stamped = next && !next.obtainedAt ? { ...next, obtainedAt: Date.now() } : next;
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (stamped) (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(stamped));
    current.current = stamped;
    setSession(stamped);
  };

  const renew = (s) => {
    renewing.current ??= refresh(s.refreshToken, ANGAZA_CLIENT_ID, s.oauth)
      .then((next) => { save(next); return next; })
      .finally(() => { renewing.current = null; });
    return renewing.current;
  };

  // One client for the console's whole life; it always reads the newest token.
  const [api] = useState(() => createClient(async () => {
    const s = current.current;
    if (!s?.idToken) return null;
    if (expiresAt(s) - Date.now() > 30_000 || !s.refreshToken) return s.idToken;
    try {
      return (await renew(s)).idToken;
    } catch {
      return s.idToken; // the server's answer is shown; the timer below signs out if needed
    }
  }));

  // Renew a minute before expiry. If the Angaza pool refuses, the session has ended: sign out.
  useEffect(() => {
    if (!session?.refreshToken) return undefined;
    const t = setTimeout(() => {
      renew(session).catch(() => { if (navigator.onLine) save(null); });
    }, Math.max(expiresAt(session) - Date.now() - 60_000, 0));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const value = useMemo(() => {
    const claims = session?.idToken ? decode(session.idToken) : null;
    // A school token stored here by mistake (it carries a school) is not an Angaza session.
    const staff = claims && !claims['custom:school_id']
      ? { sub: claims.sub, name: claims.name || claims.email, email: claims.email }
      : null;
    return {
      staff,
      api,
      signIn: (tokens, remember = false) => save(tokens, remember),
      signOut: () => save(null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return <AngazaAuthContext.Provider value={value}>{children}</AngazaAuthContext.Provider>;
}

export const useAngaza = () => useContext(AngazaAuthContext);
