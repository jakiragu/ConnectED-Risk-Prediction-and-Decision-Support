import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { useAngaza } from '../angaza/AngazaAuth.jsx';
import { completeOAuth } from './oauth.js';
export default function OAuthCallback({ platform = false }) {
  const school = useAuth(), angaza = useAngaza(), navigate = useNavigate();
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    completeOAuth(platform ? 'angaza' : 'school').then(({ tokens, remember }) => {
      if (!active) return;
      (platform ? angaza : school).signIn(tokens, remember);
      navigate(platform ? '/angaza' : '/dashboard', { replace: true });
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
    // Session changes must not cause a second authorization-code exchange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <main className="page"><div className="card"><h1>{error ? 'Sign-in needs attention' : 'Completing sign-in…'}</h1>
    {error && <><p role="alert">{error}</p><Link to={platform ? '/angaza/sign-in' : '/sign-in'}>Back to sign in</Link></>}
  </div></main>;
}
