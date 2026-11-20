import { Layout } from './ui.jsx';
import { findRoute } from './routes.jsx';

export default function App({ path }) {
  const route = findRoute(path);
  return <Layout route={route}><route.Page /></Layout>;
}
