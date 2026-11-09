import OAuthCallback from '../auth/OAuthCallback.jsx';
import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AngazaAuthProvider, useAngaza } from './AngazaAuth.jsx';
import ConsoleSignIn from './ConsoleSignIn.jsx';
import SchoolsPage from './SchoolsPage.jsx';
import NewSchoolPage from './NewSchoolPage.jsx';
import SchoolPage from './SchoolPage.jsx';
import { useNow } from './parts.jsx';
import { myTime } from './time.js';

/**
 * The Angaza console, at /angaza. Angaza staff register schools, give each its
 * first administrator, help a locked-out administrator and suspend or
 * reactivate a school. Loaded only when someone opens /angaza, so the school
 * app never downloads it.
 */
export default function AngazaApp() {
  return (
    <AngazaAuthProvider>
      <Routes>
        <Route path="auth/callback" element={<OAuthCallback platform />} />
        <Route path="sign-in" element={<ConsoleSignIn />} />
        <Route element={<RequireStaff><ConsoleLayout /></RequireStaff>}>
          <Route index element={<SchoolsPage />} />
          <Route path="schools/new" element={<NewSchoolPage />} />
          <Route path="schools/:schoolId" element={<SchoolPage />} />
          <Route path="*" element={<Navigate to="/angaza" replace />} />
        </Route>
      </Routes>
    </AngazaAuthProvider>
  );
}

function RequireStaff({ children }) {
  const { staff } = useAngaza();
  const location = useLocation();
  if (!staff) return <Navigate to="/angaza/sign-in" state={{ from: location }} replace />;
  return children;
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/**
 * A dark header band, unlike the school app's pale one: whoever is looking
 * should never wonder whether they are inside one school or across all of them.
 */
function ConsoleLayout() {
  const { staff, signOut } = useAngaza();
  const navigate = useNavigate();
  const now = useNow();
  const online = useOnline();

  function logOut() {
    signOut();
    navigate('/angaza/sign-in');
  }

  return (
    <div className="console">
      <a className="skip-link" href="#console-main">Skip to content</a>
      <header className="console-header">
        <Link to="/angaza" className="console-brand">
          <span className="brand-name">ConnectED</span>
          <span className="console-tag">Angaza console</span>
        </Link>
        <nav aria-label="Console">
          <NavLink to="/angaza" className="console-nav">Schools</NavLink>
        </nav>
        <div className="console-who">
          <span title="Your local time. School times are shown next to each school.">Your time {myTime(now)}</span>
          <span className="console-name">{staff.name}</span>
          <button type="button" className="btn link" onClick={logOut}>Log out</button>
        </div>
      </header>
      <main id="console-main" className="page console-page">
        {!online && <div className="notice warn">You are offline. The console needs a connection; it will work again once you are back online.</div>}
        <Outlet />
      </main>
    </div>
  );
}
