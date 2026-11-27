import { useEffect, useState } from 'react';

const GITHUB = 'https://github.com/myrosama/DaemonClient';
export const repo = (p) => `${GITHUB}/blob/main/${p}`;

const NAV = [
  { key: 'home', label: 'Home', href: 'https://daemonclient.uz' },
  { key: 'docs', label: 'Docs', href: '/' },
  { key: 'self-host', label: 'Self-host', href: '/self-host', xs: false },
  { key: 'api', label: 'API', href: '/api' },
  { key: 'faq', label: 'FAQ', href: '/faq', xs: false },
  { key: 'changelog', label: 'Changelog', href: '/changelog' },
];

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function Heading({ as: Tag, id, children }) {
  const hid = id || slug(typeof children === 'string' ? children : '');
  return (
    <Tag id={hid}>
      <a className="anchor" href={`#${hid}`} aria-hidden="true" tabIndex={-1}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      </a>
      {children}
    </Tag>
  );
}
// Named after Telegram's h3/h4 look; they render as h2/h3 under the page's h1.
export const H3 = (p) => <Heading as="h2" {...p} />;
export const H4 = (p) => <Heading as="h3" {...p} />;

export const Note = ({ children }) => <blockquote>{children}</blockquote>;

export function Table({ head, rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function ThemeToggle() {
  const flip = () => {
    const el = document.documentElement;
    const next = el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* private mode: theme just isn't remembered */ }
  };
  return (
    <button className="theme-toggle" type="button" onClick={flip} aria-label="Switch between light and dark theme">
      <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
      </svg>
      <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
      </svg>
    </button>
  );
}

const ROW = 27.5; // height of one side-nav link: 19.5px line + 4px padding top and bottom

// The rail is a 2px path down the left of the list that steps right for
// nested items; the blue thumb inside it marks the section being read.
function railMask(items) {
  const d = items.map((it, k) => {
    const x = it.sub ? 13 : 1;
    const y = k * ROW + 4;
    return `${k ? 'L' : 'M'}${x} ${y} L${x} ${y + 20}`;
  }).join(' ');
  const h = items.length * ROW;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 ${h}"><path d="${d}" stroke="black" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Built in the browser from the page's own headings, like Telegram's.
// The server renders nothing here, so hydration has nothing to disagree with.
function SideNav() {
  const [items, setItems] = useState([]);
  const [cur, setCur] = useState(0);
  useEffect(() => {
    const hs = [...document.querySelectorAll('.content h2[id], .content h3[id]')];
    let seenH3 = false;
    setItems(hs.map((h) => {
      if (h.tagName === 'H2') seenH3 = true;
      return { id: h.id, text: h.textContent, sub: h.tagName === 'H3' && seenH3 };
    }));
    const onScroll = () => {
      let i = 0;
      hs.forEach((h, k) => { if (h.getBoundingClientRect().top < 90) i = k; });
      setCur(i);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!items.length) return <nav className="side-nav" aria-label="On this page" />;
  let parent = cur;
  while (parent > 0 && items[parent].sub) parent--;
  const mask = railMask(items);
  return (
    <nav className="side-nav" aria-label="On this page">
      <div className="rail" aria-hidden="true" style={{ height: items.length * ROW, maskImage: mask, WebkitMaskImage: mask }}>
        <div className="rail-bg" />
        <div className="rail-thumb" style={{ marginTop: cur * ROW + 4, height: 20 }} />
      </div>
      <ul>
        {items.map((it, k) => (
          <li key={it.id}>
            <a href={`#${it.id}`} title={it.text}
               className={[it.sub && 'sub', (k === cur || k === parent) && 'on'].filter(Boolean).join(' ')}>
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot-cols foot-desktop">
        <div className="foot-col foot-brand">
          <div className="foot-h">DaemonClient</div>
          A private photo and file cloud that runs on free plans you control.
        </div>
        <div className="foot-col">
          <div className="foot-h"><a href="https://daemonclient.uz">Apps</a></div>
          <ul>
            <li><a href="https://photos.daemonclient.uz">Photos</a></li>
            <li><a href="https://drive.daemonclient.uz">Drive</a></li>
            <li><a href="https://accounts.daemonclient.uz">Your account</a></li>
          </ul>
        </div>
        <div className="foot-col">
          <div className="foot-h"><a href="/">Docs</a></div>
          <ul>
            <li><a href="/how-it-works">How it works</a></li>
            <li><a href="/self-host">Self-hosting</a></li>
            <li><a href="/api">API</a></li>
          </ul>
        </div>
        <div className="foot-col">
          <div className="foot-h"><a href="/faq">About</a></div>
          <ul>
            <li><a href="/faq">FAQ</a></li>
            <li><a href="/security">Security</a></li>
            <li><a href="/changelog">Changelog</a></li>
          </ul>
        </div>
        <div className="foot-col">
          <div className="foot-h"><a href={GITHUB}>Code</a></div>
          <ul>
            <li><a href={GITHUB}>GitHub</a></li>
            <li><a href={repo('CONTRIBUTING.md')}>Contributing</a></li>
            <li><a href={repo('LICENSE')}>License</a></li>
          </ul>
        </div>
      </div>
      <div className="foot-cols foot-mobile">
        <div className="foot-h"><a href="https://photos.daemonclient.uz">Photos</a></div>
        <div className="foot-h"><a href="https://drive.daemonclient.uz">Drive</a></div>
        <div className="foot-h"><a href="/changelog">Changelog</a></div>
        <div className="foot-h"><a href={GITHUB}>GitHub</a></div>
      </div>
    </footer>
  );
}

export function Layout({ route, children }) {
  return (
    <>
      <header className="head">
        <div className="head-inner">
          <nav aria-label="Main"><ul className="head-nav">
            {NAV.map((n) => (
              <li key={n.key} className={[n.key === route.nav && 'active', n.xs === false && 'hidden-xs'].filter(Boolean).join(' ') || undefined}>
                <a href={n.href}>{n.label}</a>
              </li>
            ))}
          </ul></nav>
          <a className="head-github hidden-xs" href={GITHUB}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
            GitHub
          </a>
        </div>
      </header>
      <ThemeToggle />
      <div className={route.side ? 'page has-side' : 'page'}>
        <main className="content">
          {route.crumb && (
            <ul className="crumbs">
              <li><a href="/">DaemonClient docs</a></li>
              <li>
                <svg viewBox="0 0 5 9" aria-hidden="true"><path d="M.7.7 4.2 4.5.7 8.3" /></svg>
                <a href={route.path}>{route.title}</a>
              </li>
            </ul>
          )}
          <h1>{route.title}</h1>
          {children}
        </main>
        {route.side && <SideNav />}
      </div>
      <Footer />
    </>
  );
}
