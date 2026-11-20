import { H3, Note, Table, repo } from '../ui.jsx';

const c = (...names) => names.map((n, i) => <span key={n}>{i ? ', ' : ''}<code>{n}</code></span>);

export default function Api() {
  return (
    <>
      <p>
        Each user's own worker answers every request. It serves the part of Immich's API that the Photos
        website needs (Photos is a fork of Immich's web app), Drive's own routes and a WebDAV mount, and it
        stores everything in your own Telegram channel.
      </p>
      <p>
        The full contract is in two files. <a href={repo('docs/API.md')}>docs/API.md</a> describes every route
        and records which app calls it, and <a href={repo('docs/openapi.yaml')}>docs/openapi.yaml</a> is an
        OpenAPI 3.1 document you can load into any tool. This page is a summary.
      </p>

      <H3>Routes</H3>
      <Table
        head={['Area', 'Routes', 'Notes']}
        rows={[
          ['Auth', c('/api/auth/login', '/logout', '/status', '/exchange'), <><code>exchange</code> trades a Firebase ID token for a session, which is how one sign-in covers all three apps.</>],
          ['Server', c('/api/server/config', '/features', '/telegram-config', '/zke-config'), 'The last two return your own secrets on purpose: your browser needs them to send and read your files. Only the owner can call them.'],
          ['Assets', <><code>/api/assets</code> and its media paths</>, 'Upload, originals, thumbnails, video playback, trash and photo details. Range requests work.'],
          ['Manifest', c('/api/assets/{id}/dc-manifest'), 'Not an Immich route. The list of parts the browser uses to read a file part by part, without the worker assembling it.'],
          ['Timeline', c('/api/timeline/buckets', '/bucket'), 'Month groups for the grid. Each request also starts one background repair job.'],
          ['Sync', c('/api/sync/stream'), 'For the phone apps. Newline-delimited JSON.'],
          ['Albums, users, search', c('/api/albums', '/api/users', '/api/search'), <>Albums and users work. Of search, only <code>search/metadata</code> returns results.</>],
          ['Drive', <><code>/api/drive/*</code>, and <code>/dav</code> for the mount</>, 'Uses different keys from Photos. The WebDAV mount uses HTTP Basic auth against a hashed token.'],
          ['Infrastructure', c('/api/health', '/proxy', '/api/selfhost/status'), <><code>/proxy</code> carries the website's file parts to and from <code>api.telegram.org</code>, and goes nowhere else.</>],
        ]}
      />
      <Note>
        <p>
          Immich features that DaemonClient doesn't have, such as people, tags, partners, shared links, jobs,
          memories and stacks, return an empty response of the right shape instead of a 404. An app that gets
          an error body where it expects a list crashes on <code>.length</code>. A 200 with nothing in it
          means the feature isn't built.
        </p>
      </Note>

      <H3>What doesn't work yet</H3>
      <Table
        head={['Feature', 'Why']}
        rows={[
          ['Phone apps', 'Native iPhone and Android apps are being built on one shared Rust core. They are not released yet.'],
          ['HEIC and some video thumbnails', <>Workers can't decode HEIC, and Telegram doesn't make thumbnails for it. In Photos, <em>Utilities &gt; Fix HEIC &amp; missing thumbnails</em> makes them in your browser, and <em>Fix video thumbnails</em> does the same for videos.</>],
          ['Face recognition, smart search, places', 'These need machine learning, and this design has nowhere to run it.'],
          ['Sharing between users', 'Not available. An install has one owner.'],
          ['Several users on one install', 'Not planned. An install has one owner.'],
        ]}
      />
    </>
  );
}
