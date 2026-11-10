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
  // Same frame as the sign-in pages, so the hand-back from Google does not flash an unstyled page.
  return (
    <div className="page" style={{ minHeight: '100vh', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="brand-name">ConnectED</div>
        <div className="brand-sub">{platform ? 'Angaza console' : 'Exam and Gradebook System'}</div>
      </div>
      <div className="card form-card" style={{ marginTop: 0 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <h2>{error ? 'Sign-in needs attention.' : 'Completing sign-in…'}</h2>
          {error ? (
            <>
              <div className="error" role="alert">{error}</div>
              <Link className="btn" style={{ alignSelf: 'center', width: 'auto', paddingInline: '1.5rem' }} to={platform ? '/angaza/sign-in' : '/sign-in'}>Back to log in</Link>
            </>
          ) : (
            <p className="hint" role="status" style={{ margin: 0 }}>Checking your Google account. This takes a moment.</p>
          )}
        </div>
      </div>
    </div>
  );
}
