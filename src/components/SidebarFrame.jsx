import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { SIDEBAR } from '../hooks/useSidebar.js';
import angazaLogo from '../assets/angaza-center-logo-horizontal.png';

/**
 * The sidebar both portals share: the product name with the portal's own line under it, the
 * menu in folding groups, Log out, the Angaza Center logo, and an edge that drags to resize.
 * The school app (Layout.jsx) and the Angaza console (AngazaApp.jsx) differ only in what they pass.
 *
 * @param {object} props
 * @param {string} props.subtitle                       e.g. "Exam and Gradebook System"
 * @param {{label:string, items:{to:string,label:string}[]}[]} props.groups  only what this person may open
 * @param {string} props.activeSection                  the `to` of the current page's menu entry
 * @param {object} props.sidebar                        what useSidebar() returned
 * @param {(e: Event) => void} props.onLogOut
 */
export default function SidebarFrame({ subtitle, groups, activeSection, sidebar, onLogOut }) {
  const { width, setWidth, collapsed, setGroupOpen } = sidebar;
  const aside = useRef(null);
  const activeGroup = groups.find((g) => g.items.some((i) => i.to === activeSection))?.label;
  // The group holding the current page always opens, so the highlighted link is never hidden.
  useEffect(() => { if (activeGroup) setGroupOpen(activeGroup, true); }, [activeGroup, setGroupOpen]);

  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = aside.current.getBoundingClientRect().left;
    const startX = e.clientX;
    let dragged = false;
    // A click without movement is not a resize (it would undo a double-click reset).
    const move = (ev) => {
      if (!dragged && Math.abs(ev.clientX - startX) < 3) return;
      dragged = true;
      setWidth(ev.clientX - left, false);
    };
    const end = (ev) => {
      if (dragged) setWidth(ev.clientX - left, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }
  function resizeByKey(e) {
    const step = e.shiftKey ? SIDEBAR.step * 3 : SIDEBAR.step;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width - step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width + step); }
    if (e.key === 'Home') { e.preventDefault(); setWidth(SIDEBAR.min); }
    if (e.key === 'End') { e.preventDefault(); setWidth(SIDEBAR.max); }
  }

  return (
    <aside className="sidebar" id="sidebar" ref={aside}>
      <div className="brand">
        <div className="brand-name">ConnectED</div>
        <div className="brand-sub">{subtitle}</div>
      </div>
      <nav className="nav" aria-label="Main">
        {groups.map((group) => {
          const open = !collapsed.has(group.label);
          const id = `nav-group-${group.label.toLowerCase().replace(/\s+/g, '-')}`;
          return (
            <div key={group.label} className={`nav-group${open ? ' open' : ''}`}>
              <button type="button" className="nav-group-toggle" aria-expanded={open} aria-controls={id}
                onClick={() => setGroupOpen(group.label, !open)}>
                <span>{group.label}</span>
                <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {open && (
                <div id={id} className="nav-group-items">
                  {group.items.map((item) => (
                    <Link key={item.to} to={item.to} aria-current={activeSection === item.to ? 'page' : undefined}>
                      {item.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <a href="#log-out" className="danger" onClick={onLogOut}>
          Log out
        </a>
      </nav>
      <div className="sidebar-partner">
        <img src={angazaLogo} alt="Angaza Center" width="524" height="83" />
      </div>
      <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the menu"
        aria-valuemin={SIDEBAR.min} aria-valuemax={SIDEBAR.max} aria-valuenow={width} tabIndex={0}
        title="Drag to resize. Double-click to reset." onPointerDown={startResize} onKeyDown={resizeByKey}
        onDoubleClick={() => setWidth(SIDEBAR.default)} />
    </aside>
  );
}
