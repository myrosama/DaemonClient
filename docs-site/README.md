# docs-site — the documentation site

A single self-contained `index.html` deployed to the `docs` Firebase Hosting
target (`daemonclient-docs.web.app`, intended for `docs.daemonclient.uz`).

```bash
firebase deploy --only hosting:docs
```

No build step, no dependencies, no external requests — markup, styles and the
small amount of script it needs are all inline. It renders offline from a file://
URL, which makes it easy to check a change before deploying.

## What goes here vs in `docs/`

The Markdown files in [`../docs`](../docs) are the source of truth and are what
contributors read in the repository. This site is the same material laid out for
someone who has not cloned anything.

When they disagree, the Markdown wins and this is stale. Fix it or delete the
section — a documentation site that lies is worse than none, because people act
on it.
