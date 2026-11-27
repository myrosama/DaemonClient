import { renderToString } from 'react-dom/server';
import App from './App.jsx';

export { ROUTES } from './routes.jsx';
export const render = (path) => renderToString(<App path={path} />);
