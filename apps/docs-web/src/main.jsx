import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const root = document.getElementById('root');
// Built pages say which route they were rendered for: Firebase serves 404.html
// for /api/ or /api/index, and the client must hydrate that same page.
const app = <App path={root.dataset.route || window.location.pathname} />;
// Built pages arrive already rendered; the dev server sends an empty root.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
