import { H3, Note } from '../ui.jsx';

export default function Home() {
  return (
    <>
      <p>
        DaemonClient is a private photo and file cloud that costs nothing to run. Each user gets their own{' '}
        <strong>Telegram</strong> bot and private channel to hold the files, and their own{' '}
        <strong>Cloudflare</strong> worker and D1 database to keep the index. Files are encrypted before they
        reach Telegram, and there is no shared server in between.
      </p>
      <p>
        A self-hosted install doesn't use anything we run. Your files and credentials stay on your own
        accounts, nothing reports back to us, and every web app built for self-hosting is checked at build
        time to make sure it contains none of our addresses. If this project disappeared, your install would
        keep working: the files are in your Telegram channel, the index is in your D1 database and the code is
        in your clone, under AGPL-3.0.
      </p>
      <hr />

      <H3>How it works</H3>
      <p>
        Each user has one path for their data: their device, their worker, their Telegram channel. On the
        web the browser encrypts a file and sends it straight to Telegram in parts, so the worker only keeps
        the index. That is also how a whole photo library fits in Cloudflare's free plan.
      </p>
      <Note><p><a className="more" href="/how-it-works">Read how DaemonClient stores and encrypts files »</a></p></Note>
      <hr />

      <H3>Self-hosting</H3>
      <p>
        You can run all of it on your own Telegram, Cloudflare and Firebase accounts. One guided command
        sets it up in about ten minutes, most of which you spend in Telegram and Cloudflare.
      </p>
      <Note><p><a className="more" href="/self-host">Set up your own copy »</a></p></Note>
      <hr />

      <H3>API</H3>
      <p>
        Each user's worker is the whole API: the routes the Photos website uses, Drive's routes and a WebDAV
        mount for your file manager.
      </p>
      <Note><p><a className="more" href="/api">See the API reference »</a></p></Note>
      <hr />

      <H3>Security</H3>
      <p>
        Photos and Drive encrypt files in your browser before they go to Telegram. An install belongs to one
        owner, and your files never pass through a DaemonClient server shared with other users. On a self-hosted install there
        are two things you must keep safe: your encryption keys and your Telegram channel.
      </p>
      <Note><p><a className="more" href="/security">Read the security model »</a></p></Note>
      <hr />

      <H3>Questions and changes</H3>
      <p>
        The <a href="/faq">FAQ</a> covers cost, privacy, Telegram and what happens if this project stops.
        The <a href="/changelog">changelog</a> lists every change people can see, newest first.
      </p>
    </>
  );
}
