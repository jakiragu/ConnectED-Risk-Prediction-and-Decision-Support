import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { db, dropFor } from '../offline/db.js';
import { useLive } from '../offline/useLive.js';
import { getState, startSync } from '../offline/syncEngine.js';
import SyncBar from './SyncBar.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { useSidebar } from '../hooks/useSidebar.js';
import SidebarFrame from './SidebarFrame.jsx';
import { SCHOOL_SUSPENDED_EVENT } from '../api/graphql.js';
import { describeRole } from '../roles.js';

/**
 * Grouped by purpose rather than listed by feature. Every user: dashboard, classes, assessments, results.
 * Attendance, report cards and risk prediction: administrators and class teachers. School risk, teachers
 * and settings: administrators.
 */
const adminOrClassTeacher = ({ isAdmin, isClassTeacher }) => isAdmin || isClassTeacher;
const adminOnly = ({ isAdmin }) => isAdmin;
const NAV_GROUPS = [
  {
    label: 'Teaching', items: [
      { to: '/dashboard', label: 'Dashboard' },
      { to: '/assessments', label: 'Assessments' },
      { to: '/attendance', label: 'Attendance', show: adminOrClassTeacher },
    ]
  },
  {
    label: 'Results', items: [
      { to: '/results', label: 'Results' },
      { to: '/report-cards', label: 'Report cards', show: adminOrClassTeacher },
    ]
  },
  {
    label: 'Insights', items: [
      { to: '/risk', label: 'Risk prediction', show: adminOrClassTeacher },
      { to: '/school-risk', label: 'School risk', show: adminOnly },
    ]
  },
  {
    label: 'Administration', items: [
      { to: '/classes', label: 'Classes' },
      { to: '/teachers', label: 'Teachers', show: adminOnly },
      { to: '/settings', label: 'Settings', show: adminOnly },
    ]
  },
  { label: 'You', items: [{ to: '/profile', label: 'My Profile' }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

function breadcrumbsFor(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const home = { label: 'Dashboard', to: '/dashboard' };

  if (path === '/dashboard') {
    return [{ label: 'Dashboard' }];
  }

  if (path === '/classes') {
    return [home, { label: 'Classes' }];
  }

  // Before the /classes/<id> pattern below, which would also match these.
  if (path === '/classes/promotion') {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Close the school year' }];
  }

  if (path === '/students/past') {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Past students' }];
  }

  const classStudents = path.match(/^\/classes\/([^/]+)\/students$/);
  if (classStudents) {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Class', to: `/classes/${classStudents[1]}` }, { label: 'Students' }];
  }

  if (/^\/classes\/[^/]+$/.test(path)) {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Class' }];
  }

  if (path.startsWith('/settings')) {
    return [home, { label: 'Settings' }];
  }

  if (path === '/interventions/new') {
    return [home, { label: 'Log an intervention' }];
  }

  // Without a recorded origin (an address typed or opened from a bookmark), only the page itself.
  if (/^\/students\/[^/]+\/risk$/.test(path)) {
    return [home, { label: 'Student profile' }];
  }

  if (/^\/students\/[^/]+\/interventions$/.test(path)) {
    return [home, { label: 'Interventions' }];
  }

  if (path === '/assessments') {
    return [home, { label: 'Assessments' }];
  }

  if (path === '/assessments/new') {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'New assessment' }];
  }

  if (/^\/assessments\/[^/]+\/edit$/.test(path)) {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'Edit assessment' }];
  }

  if (/^\/assessments\/[^/]+\/scores$/.test(path)) {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'Assessment marks' }];
  }

  const pages = {
    '/results': 'Results',
    '/attendance': 'Attendance',
    '/report-cards': 'Report cards',
    '/risk': 'Risk prediction',
    '/school-risk': 'School risk',
    '/teachers': 'Teachers',
    '/terms': 'Terms',
  };

  return pages[path]
    ? [home, { label: pages[path] }]
    : [home];
}

/**
 * The trail the user actually took. Pages that open a student (or an intervention form) pass where
 * they were as state.from (see navigation.js), so the trail is that page's own trail followed by
 * this page, rather than one fixed route. A profile opened from the dashboard reads
 * Dashboard > Student profile; one opened from a class list reads ... > Students > Student profile.
 */
function trailFor(location) {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const from = typeof location.state?.from === 'string' ? location.state.from : null;
  const fromPath = from ? from.split(/[?#]/)[0].replace(/\/+$/, '') || '/' : null;
  const student = path.match(/^\/students\/([^/]+)\/(risk|interventions)$/);

  if ((!student && path !== '/interventions/new') || !fromPath || fromPath === path) {
    return breadcrumbsFor(path);
  }

  const origin = breadcrumbsFor(fromPath);
  origin[origin.length - 1] = { ...origin[origin.length - 1], to: from };

  if (path === '/interventions/new') return [...origin, { label: 'Log an intervention' }];

  const [, studentId, page] = student;
  if (page === 'risk') return [...origin, { label: 'Student profile' }];

  // The intervention form: the profile is in the trail only when the user came through it.
  const crumbs = [...origin];
  if (location.state?.via === 'profile') {
    crumbs.push({ label: 'Student profile', to: `/students/${studentId}/risk`, state: { from } });
  }
  crumbs.push({ label: 'Interventions' });
  return crumbs;
}

function activeSectionFor(pathname) {
  if (pathname.startsWith('/classes/') || pathname.startsWith('/students/')) {
    return '/classes';
  }

  if (pathname.startsWith('/assessments/')) {
    return '/assessments';
  }

  if (pathname.startsWith('/settings')) {
    return '/settings';
  }

  return NAV.find((item) =>
    pathname === item.to || pathname.startsWith(`${item.to}/`)
  )?.to || '/dashboard';
}

export default function Layout() {
  const { actor, isAdmin, signOut, displayName, schoolName } = useAuth();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const isClassTeacher = classes.some((c) => c.is_class_teacher);
  const { role, detail: roleDetail } = describeRole({ isAdmin, classes });
  const navigate = useNavigate();
  const location = useLocation();
  const breadcrumbs = trailFor(location);
  const activeSection = activeSectionFor(location.pathname);

  useEffect(() => startSync(actor), [actor.sub]);

  // Angaza can suspend a school. Every request is then refused, so instead of an error on
  // every page, one page explains the pause. Work on this device stays queued meanwhile.
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    const onSuspended = () => setSuspended(true);
    window.addEventListener(SCHOOL_SUSPENDED_EVENT, onSuspended);
    return () => window.removeEventListener(SCHOOL_SUSPENDED_EVENT, onSuspended);
  }, []);

  // Sidebar: folding groups, hiding it, and dragging its edge to resize. Remembered on this device.
  const sidebar = useSidebar();
  const { width, hidden, setHidden } = sidebar;
  const groups = NAV_GROUPS
    .map((g) => ({ label: g.label, items: g.items.filter((item) => !item.show || item.show({ isAdmin, isClassTeacher })) }))
    .filter((g) => g.items.length);

  async function logOut(e) {
    e.preventDefault();
    const { pending, failed, held } = await getState();
    const unsent = pending + failed + held;
    if (unsent && !window.confirm(
      `${unsent} change${unsent === 1 ? ' has' : 's have'} (marks or interventions) not reached the server yet. ` +
      'They will stay on this device and be sent the next time you sign in. Log out?'
    )) return;
    const sub = actor.sub;
    signOut();
    navigate('/sign-in');
    if (!unsent) await dropFor(sub);
  }

  return (
    <div className={`shell${hidden ? ' nav-hidden' : ''}`} style={{ '--sidebar-w': `${width}px` }}>
      {!hidden && (
        <SidebarFrame subtitle="Exam and Gradebook System" groups={groups} activeSection={activeSection} sidebar={sidebar} onLogOut={logOut} />
      )}

      <div className="main">
        <header className="topbar">
          <button type="button" className="menu-toggle" aria-controls="sidebar" aria-expanded={!hidden}
            aria-label={hidden ? 'Show the menu' : 'Hide the menu'} title={hidden ? 'Show the menu' : 'Hide the menu'}
            onClick={() => setHidden(!hidden)}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
          <GlobalSearch />
          <SyncBar />
          <div className="who">
            {/* Only the name leads to the profile. Hovering it (or focusing it) shows the role. */}
            <div className="user-menu">
              <Link to="/profile" className="user-name" aria-describedby="user-card">{displayName}</Link>
              <div className="user-card" id="user-card">
                <b>{displayName}</b>
                <span className="pill role">{role}</span>
                {roleDetail && <span className="hint">{roleDetail}</span>}
                <Link to="/profile" className="user-card-link" tabIndex={-1}>Go to my profile</Link>
              </div>
            </div>
            <span className="school-name">{schoolName || 'School profile unavailable'}</span>
          </div>
        </header>
        <main className="page">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <ol>
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`}>
                  {crumb.to ? (
                    <Link to={crumb.to} state={crumb.state}>{crumb.label}</Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          {suspended ? (
            <section className="empty suspended-school" aria-labelledby="suspended-title">
              <b id="suspended-title">ConnectED is paused for {schoolName || 'your school'}</b>
              <p>
                Angaza has paused your school’s access. Your marks, results and records are kept, and anything
                entered on this device is waiting to be sent. Contact Angaza to restore access.
              </p>
              <div className="row">
                <button type="button" className="btn" onClick={() => window.location.reload()}>Try again</button>
                <a href="#log-out" className="btn secondary" onClick={logOut}>Log out</a>
              </div>
            </section>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}