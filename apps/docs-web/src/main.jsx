import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const root = document.getElementById('root');
const app = <App path={window.location.pathname} />;
// Built pages arrive already rendered; the dev server sends an empty root.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
