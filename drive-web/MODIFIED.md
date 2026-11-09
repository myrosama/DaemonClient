# Changed files that cannot carry a notice

drive-web/ is derived from File Browser at
filebrowser/filebrowser@e8a388f (Apache-2.0; see `LICENSE.filebrowser`).
Changed `.vue`, `.ts`, `.js`, `.css` and `.html` files say so in a header. These
files were changed by DaemonClient contributors too, but they are JSON or
generated, so they carry no header:

- `package.json`
- `pnpm-lock.yaml`
- `public/manifest.json`
