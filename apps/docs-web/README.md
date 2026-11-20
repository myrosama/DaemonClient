# docs-web: the documentation site

The site at `docs.daemonclient.uz` (Firebase Hosting target `docs`). It is a
small Vite + React app laid out after core.telegram.org's developer pages. The
build renders every page to static HTML, so pages read without JavaScript, and
the browser then hydrates them for the theme switch and the section rail.

```bash
npm install
npm run dev      # local preview at http://localhost:5173
npm run build    # writes dist/: one .html file per page, plus assets/
firebase deploy --only hosting:docs   # from the repository root, after a build
```

Firebase serves `dist/` with clean URLs, so `/faq` serves `faq.html`.

## Where things are

| File | What it is |
|---|---|
| `src/routes.jsx` | Every page: its address, title, description and whether it has a section rail. Add a page here. |
| `src/pages/*.jsx` | The page text. |
| `src/ui.jsx` | The top bar, breadcrumb, section rail, footer, theme switch, and the `H3`, `H4`, `Note` and `Table` helpers. |
| `src/styles.css` | All styling. Dark mode follows the system until someone picks a theme. |
| `public/theme.js` | Sets the theme before the page paints, so a saved dark theme never flashes light. |
| `scripts/prerender.mjs` | Renders each route to `dist/<page>.html` after the build. |

The section rail on the right is built in the browser from the page's `H3` and
`H4` headings, so a new heading shows up in it automatically.

## Rules for the text

- The Markdown in [`../../docs`](../../docs) is the source of truth. When this
  site disagrees with it, the site is wrong: fix the page or remove the section.
- The changelog is newest first, with dates written out (November 20, 2026) and
  no dates for anything that hasn't shipped. Each line says what changed for the
  person using DaemonClient and matches what the code does.
- The repository is public. Don't describe a security problem here until the fix
  is live.
- The site's content security policy (in `firebase.json`) allows no inline
  scripts or inline styles. Put styles in `src/styles.css`, and don't use React's
  `style` prop in anything the server renders.
