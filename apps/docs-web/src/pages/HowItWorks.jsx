import { H3, Note, Table, repo } from '../ui.jsx';

const PATH = `   your phone / browser / any file manager (WebDAV)
                    │
                    ▼
      your Cloudflare Worker  ──── your D1 database
                    │              (file index, settings, keys)
                    ▼
      your Telegram bot  ─────────► your private channel
                                    (AES-256-GCM encrypted 19 MB parts)`;

const FLOW = `  UPLOAD                                  READ
  browser                                 browser
    │ slice at 19 MB                        │ GET /api/assets/{id}/dc-manifest
    │ encrypt each part                     │   ← small JSON: the parts' file_ids
    ├── part ──► relay ──► Telegram         ├── fetch part ──► relay ──► Telegram
    │        ← file_id                      │ decrypt locally
    └── metadata + file_ids ──► worker      └── show`;

export default function HowItWorks() {
  return (
    <>
      <p>
        This page explains where your files go, how they are encrypted, how sign-in works and which limits
        shaped the design.
      </p>

      <H3 id="one-path-per-user">One path per user</H3>
      <p>
        Every user has their own path: their device, then their worker, then their Telegram channel. There
        is no shared file server, and no database of ours holds your files or their index.
      </p>
      <pre>{PATH}</pre>
      <p>
        On the web, your browser does the heavy work. It splits a file into parts, encrypts each one and
        sends them to Telegram through your worker's relay, which streams the bytes along without storing or
        decrypting them. A service worker reads files back the same way, fetching only the parts a given byte
        range needs. The worker never assembles a whole file, so it stays inside the free plan's CPU and
        memory limits.
      </p>
      <pre>{FLOW}</pre>

      <H3>Storage</H3>
      <p>
        Telegram's Bot API accepts uploads larger than 20 MB but won't let a bot download them, so you could
        send a 60 MB file and never get it back. DaemonClient therefore splits everything into parts of 19 MB
        of plaintext and never merges them.
      </p>
      <p>A single photo is stored as up to four pieces:</p>
      <Table
        head={['Piece', 'Where', 'What it is for']}
        rows={[
          [<code>thumbhash</code>, 'A column in D1', 'About 25 bytes. The blurred placeholder the grid shows before any network request.'],
          ['Thumbnail', 'One Telegram message', 'The small image in the grid.'],
          ['Preview', 'One Telegram message', 'A larger image for the detail view.'],
          ['Parts', 'One Telegram message each', <>The file itself, recorded as a list of <code>file_id</code>s.</>],
        ]}
      />
      <p>
        The thumbnail and preview exist because of CPU limits. A worker on the free plan can't make a
        thumbnail from a 40 MB original, so your browser makes them before upload.
      </p>
      <Note>
        <p>
          Every photo has a checksum, <code>base64(SHA-1(plaintext))</code>, which the worker works out itself
          when the app doesn't send one. Without it the "do you already have these?" check never matches, and
          an app would upload your whole library again every time it restarted.
        </p>
      </Note>

      <H3>Encryption</H3>
      <p>
        Photos and Drive store files encrypted in your Telegram channel. What differs is where the key is
        kept, and so who else can use it.
      </p>
      <Table
        head={['Key', 'Where it is kept', 'Who can decrypt', 'Used by']}
        rows={[
          ['Stored key', 'Your own D1 database', 'Your signed-in browser, and your own worker', <>Photos, and Drive by default. Drive's mount needs it, because your worker encrypts and decrypts files for your file manager.</>],
          ['Your own password', 'Nowhere. You type it on each device', 'Only your browser', 'Drive, if you choose a custom password'],
          ['No key', '', 'Anyone who can read your channel', 'Drive, if you turn encryption off'],
        ]}
      />
      <p>
        Files are encrypted with AES-256-GCM. Keys are derived with PBKDF2-SHA256 at 100,000 iterations, and
        each part gets a fresh 12-byte IV.
      </p>
      <p>
        Keeping the Photos key in your database is a trade-off. It lets your worker encrypt uploads that
        reach it with the file attached, work out checksums and read photo details, which a server without
        the key couldn't do. The worker that holds the key serves only you and runs on your own Cloudflare
        account. On a self-hosted install it isn't our machine in any sense.
      </p>
      <Note>
        <p>
          If your worker has to encrypt an upload and its key is missing, it refuses the upload instead of
          storing it unencrypted. Installs set up before July 27, 2026 didn't always do this. If yours is that old, read
          the <a href={repo('docs/SELF_HOSTING.md')}>migration note in the self-hosting guide</a>.
        </p>
      </Note>

      <H3>Sign-in</H3>
      <p>
        An install has one owner. Self-host setup records your account as the owner, and an install without
        one is claimed by the first sign-in through the worker's own password login. Every signed-in route
        checks that owner, so another account in your Firebase project can't read your
        data. The check sits in the one place every request is authenticated, so routes added later are
        covered too.
      </p>
      <p>
        The worker accepts two kinds of credential and tells them apart by counting dots. A{' '}
        <strong>Firebase ID token</strong> has three parts and is verified with RS256 against Google's public
        certificates, with <code>aud</code>, <code>iss</code> and <code>exp</code> checked. A{' '}
        <strong>session token</strong> has two, <code>base64(payload).hmac</code>, and is signed with the
        install's own secret, so a session made for one worker doesn't work on another.
      </p>
      <p>
        On the hosted service one sign-in covers all three apps. A cookie on the parent domain lets Photos and
        Drive ask for a fresh ID token and trade it for their own session. The refresh token stays in an
        HttpOnly cookie that JavaScript can't read. A self-hosted install skips all of this and signs in
        against its own Firebase project.
      </p>

      <H3>Limits</H3>
      <p>
        Most of the design that looks overbuilt comes from the limits of Cloudflare Workers' free plan:
      </p>
      <Table
        head={['Limit', 'Value', 'What it means here']}
        rows={[
          ['CPU time', '10 ms per request', 'No image decoding, video conversion or large buffers. HEIC thumbnails are made in your browser.'],
          ['Memory', '128 MB', 'Responses stream, with no more than about two parts in memory at once.'],
          ['Subrequests', '50 outside requests per request', 'A file of 50 parts already reaches the limit, so background repair runs one job per request.'],
          ['Requests', '100,000 a day', 'Every part the relay carries counts, so browsing a big library hard can reach it.'],
          ['Request body', '100 MB', 'Files go to Telegram in parts from your device, never as one request through the worker.'],
          ['Telegram download', '20 MB', 'Where the 19 MB parts come from.'],
        ]}
      />
      <Note>
        <p>
          When a request goes over the CPU or memory limit, Cloudflare stops it and returns error 1102 with no
          CORS headers, so the browser reports a CORS error. If a media request fails with a CORS error you
          can't explain, check for 1102 first.
        </p>
      </Note>

      <H3>The repository</H3>
      <Table
        head={['Folder', 'What it is']}
        rows={[
          [<code>apps/photos-web/</code>, "The Photos website, a fork of Immich's web app. The Immich server isn't used."],
          [<code>apps/drive-web/</code>, 'The Drive website.'],
          [<code>apps/accounts-web/</code>, 'Sign-up, setup and the dashboard at accounts.daemonclient.uz.'],
          [<><code>apps/site/</code>, <code>apps/docs-web/</code></>, 'The landing page and these docs.'],
          [<><code>apps/ios/</code>, <code>apps/android/</code></>, 'The phone apps, still being built.'],
          [<code>core/</code>, 'The shared Rust engine. The phone apps will use it first and the websites later.'],
          [<code>workers/user-worker/</code>, "Each user's own worker, which is the whole Photos and Drive API. Deployed once per user."],
          [<code>workers/deployment/</code>, "Sets up and updates users' workers for the hosted service."],
          [<code>workers/auth/</code>, 'The sign-in service the websites share.'],
          [<code>packages/schema/</code>, 'The database schema, defined once.'],
          [<code>selfhost/</code>, 'The self-hosting command-line tool.'],
        ]}
      />
      <p>
        Most folders have their own README, and <a href={repo('docs/ARCHITECTURE.md')}>docs/ARCHITECTURE.md</a>{' '}
        has the full technical write-up.
      </p>
    </>
  );
}
