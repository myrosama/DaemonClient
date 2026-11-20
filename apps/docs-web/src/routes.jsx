import Home from './pages/Home.jsx';
import HowItWorks from './pages/HowItWorks.jsx';
import SelfHost from './pages/SelfHost.jsx';
import Api from './pages/Api.jsx';
import Security from './pages/Security.jsx';
import Faq from './pages/Faq.jsx';
import Changelog from './pages/Changelog.jsx';

function NotFound() {
  return <p>There's no page at this address. Go to the <a href="/">docs home</a>.</p>;
}

// path: the clean URL; file: what the prerender writes; nav: which top-bar
// item is underlined; side: show the section rail.
export const ROUTES = [
  { path: '/', file: 'index.html', nav: 'docs', title: 'DaemonClient docs', tab: 'DaemonClient docs', Page: Home,
    desc: 'How DaemonClient works and how to run it yourself: storage, encryption, sign-in, the API and self-hosting.' },
  { path: '/how-it-works', file: 'how-it-works.html', nav: 'docs', title: 'How it works', crumb: true, side: true, Page: HowItWorks,
    desc: 'How DaemonClient keeps your photos and files in your own Telegram channel through your own worker: storage, encryption, sign-in and limits.' },
  { path: '/self-host', file: 'self-host.html', nav: 'self-host', title: 'Self-hosting', crumb: true, side: true, Page: SelfHost,
    desc: 'Run DaemonClient on your own Telegram, Cloudflare and Firebase accounts: what you need, the guided setup, commands, updates and troubleshooting.' },
  { path: '/api', file: 'api.html', nav: 'api', title: 'API reference', crumb: true, side: true, Page: Api,
    desc: "The routes each user's DaemonClient worker answers, and what doesn't work yet." },
  { path: '/security', file: 'security.html', nav: 'docs', title: 'Security model', crumb: true, side: true, Page: Security,
    desc: 'What DaemonClient encrypts where, who can read your files, and what you must keep safe.' },
  { path: '/faq', file: 'faq.html', nav: 'faq', title: 'FAQ', crumb: true, side: true, Page: Faq,
    desc: 'Short answers about DaemonClient: privacy, cost, Telegram, self-hosting and contributing.' },
  { path: '/changelog', file: 'changelog.html', nav: 'changelog', title: 'Changelog', crumb: true, side: true, Page: Changelog,
    desc: 'What changed in DaemonClient, newest first.' },
  { path: '/404', file: '404.html', nav: null, title: 'Page not found', crumb: false, Page: NotFound,
    desc: 'This page does not exist.' },
];
for (const r of ROUTES) if (!r.tab) r.tab = `${r.title} - DaemonClient docs`;

export function findRoute(pathname) {
  const p = pathname.replace(/\.html$/, '').replace(/\/index$/, '/').replace(/(.)\/$/, '$1') || '/';
  return ROUTES.find((r) => r.path === p) || ROUTES[ROUTES.length - 1];
}
