import OAuthCallback from '../auth/OAuthCallback.jsx';
import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AngazaAuthProvider, useAngaza } from './AngazaAuth.jsx';
import ConsoleSignIn from './ConsoleSignIn.jsx';
import SchoolsPage from './SchoolsPage.jsx';
import NewSchoolPage from './NewSchoolPage.jsx';
import SchoolPage from './SchoolPage.jsx';
import { useNow } from './parts.jsx';
import { myTime } from './time.js';
import ProfilePage, { STAFF_ROLE } from './ProfilePage.jsx';
import GoogleLinkReturn from '../auth/GoogleLinkReturn.jsx';
import SidebarFrame from '../components/SidebarFrame.jsx';
import { useSidebar } from '../hooks/useSidebar.js';
import { GET_STAFF_PROFILE } from '../api/accountOperations.js';

/**
 * The Angaza console, at /angaza. Angaza staff register schools, give each its
 * first administrator, help a locked-out administrator and suspend or
 * reactivate a school, and look after their own sign-in on My Profile. Loaded only when someone opens /angaza, so the school
 * app never downloads it.
 */
export default function AngazaApp() {
  return (
    <AngazaAuthProvider>
      <Routes>
        <Route path="auth/callback" element={<OAuthCallback platform />} />
        <Route path="link/google" element={<GoogleLinkReturn platform />} />
        <Route path="sign-in" element={<ConsoleSignIn />} />
        <Route element={<RequireStaff><ConsoleLayout /></RequireStaff>}>
          <Route index element={<SchoolsPage />} />
          <Route path="schools/new" element={<NewSchoolPage />} />
          <Route path="schools/:schoolId" element={<SchoolPage />} />
          <Route path="profile" element={<ProfilePage />} />
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

const NAV_GROUPS = [
  { label: 'Schools', items: [{ to: '/angaza', label: 'All schools' }, { to: '/angaza/schools/new', label: 'Add a school' }] },
  { label: 'You', items: [{ to: '/angaza/profile', label: 'My Profile' }] },
];
const activeSectionFor = (pathname) => {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/angaza/profile') return '/angaza/profile';
  if (path === '/angaza/schools/new') return '/angaza/schools/new';
  return '/angaza';
};

/**
 * The same frame as the school app (sidebar, top bar, the name leading to My Profile), so Angaza
 * staff find things where school staff do. The line under the product name and the label at the
 * right of the top bar say this is the console, across all schools, not one school's gradebook.
 */
function ConsoleLayout() {
  const { staff, api, signOut } = useAngaza();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();
  const online = useOnline();
  const sidebar = useSidebar();
  const { width, hidden, setHidden } = sidebar;
  // The name on the staff record; the token's name (or email) until it arrives.
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    let active = true;
    api(GET_STAFF_PROFILE).then(({ getStaffProfile }) => { if (active) setProfile(getStaffProfile); }).catch(() => {});
    return () => { active = false; };
  }, [api, staff.sub]);
  const displayName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || staff.name;

  function logOut(e) {
    e?.preventDefault();
    signOut();
    navigate('/angaza/sign-in');
  }

  return (
    <div className={`shell console${hidden ? ' nav-hidden' : ''}`} style={{ '--sidebar-w': `${width}px` }}>
      <a className="skip-link" href="#console-main">Skip to content</a>
      {!hidden && (
        <SidebarFrame subtitle="Angaza Center Console" groups={NAV_GROUPS} activeSection={activeSectionFor(location.pathname)}
          sidebar={sidebar} onLogOut={logOut} />
      )}
      <div className="main">
        <header className="topbar">
          <button type="button" className="menu-toggle" aria-controls="sidebar" aria-expanded={!hidden}
            aria-label={hidden ? 'Show the menu' : 'Hide the menu'} title={hidden ? 'Show the menu' : 'Hide the menu'}
            onClick={() => setHidden(!hidden)}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
          <span className="hint" title="Your local time. School times are shown next to each school.">Your time {myTime(now)}</span>
          <div className="who">
            {/* As in the school app: only the name leads to the profile; hovering or focusing it shows the role. */}
            <div className="user-menu">
              <Link to="/angaza/profile" className="user-name" aria-describedby="user-card">{displayName}</Link>
              <div className="user-card" id="user-card">
                <b>{displayName}</b>
                <span className="pill role">{STAFF_ROLE}</span>
                <span className="hint">Registers schools and their first administrators</span>
                <Link to="/angaza/profile" className="user-card-link" tabIndex={-1}>Go to my profile</Link>
              </div>
            </div>
            <span className="school-name">Angaza Center</span>
          </div>
        </header>
        <main id="console-main" className="page console-page">
          {!online && <div className="notice warn">You are offline. The console needs a connection; it will work again once you are back online.</div>}
          <Outlet context={{ profile, setProfile }} />
        </main>
      </div>
    </div>
  );
}
