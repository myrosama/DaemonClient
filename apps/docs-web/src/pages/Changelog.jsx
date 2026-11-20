import { H3, H4, Note } from '../ui.jsx';

// Newest first. One entry per release day, dates written out, no dates for
// anything that hasn't shipped. Each line says what changed for the person
// using DaemonClient, and matches what the code does.
export default function Changelog() {
  return (
    <>
      <Note>
        <p>
          Every change people can see, newest first. Hosted clouds are updated on a schedule. Self-hosted
          installs get changes with <code>git pull</code> and <code>daemonclient update</code>.
        </p>
      </Note>

      <H3>Coming next</H3>
      <ul>
        <li>A native iPhone app for Photos, built on a shared Rust core. Android follows.</li>
        <li>Faster sync for big libraries: your cloud will send only what changed since the last sync, instead of the whole library.</li>
        <li>The Photos and Drive websites move onto the same core as the apps, so one fix reaches every app.</li>
      </ul>

      <H3>Recent changes</H3>

      <H4>November 20, 2026</H4>
      <ul>
        <li>Deleting many photos at once now removes every one of them from your Telegram channel, up to 100 messages per request. Before, it could stop partway on Cloudflare's free plan.</li>
        <li>A deleted photo leaves your library immediately and is never shown again. Its record stays until Telegram confirms the delete, so nothing is left behind if Telegram refuses the first time.</li>
        <li>Restore now says plainly that deleted photos can't be brought back.</li>
        <li>Old deletion records are cleaned up after 90 days again, and finished deletions no longer show in Trash.</li>
        <li>The optional HEIC processor has been removed. iPhone photos get their thumbnails from the <em>Fix HEIC</em> tool in Photos, which runs in your browser. If you deployed a processor to your own Vercel account, keep it running for now, because clouds that haven't updated yet still call it. This page will say when it's safe to delete.</li>
        <li>Self-hosting needs Node.js 22.13 or newer. Node 20 reached end of life in April 2026 and broke the setup tool's prompts. <code>install.sh</code> fetches a private copy if yours is older.</li>
        <li>For contributors: the repository is grouped by role, with <code>apps/</code> for what people open, <code>workers/</code> for the Cloudflare Workers, <code>core/</code> for the shared engine and <code>packages/</code> for shared code. Outdated docs were removed.</li>
      </ul>

      <H4>November 18, 2026</H4>
      <ul>
        <li>If Cloudflare stops accepting your cloud's authorization, your dashboard now asks you to reconnect Cloudflare. It takes a minute, keeps every file, and has to use the same Cloudflare account as before.</li>
        <li>Only one update at a time can use your cloud's Cloudflare authorization, so signing in on two devices at once can no longer break updates.</li>
        <li>Your cloud now stores the preview, photo details and phone-made video copy that the coming phone apps send with each upload.</li>
      </ul>

      <H4>November 15, 2026</H4>
      <ul>
        <li>Files you delete from a mounted drive (WebDAV, in Finder or another file manager) go to Trash instead of disappearing, and uploads through the mount are checked part by part.</li>
      </ul>

      <H4>November 14, 2026</H4>
      <ul>
        <li>New accounts no longer get stuck on "can't reach your cloud". The dashboard waits until a new cloud's address works everywhere before opening it.</li>
        <li>Drive signs you in through your account page, so Photos and Drive share one sign-in with the same human check.</li>
      </ul>

      <H4>November 2, 2026</H4>
      <ul>
        <li>Drive has a new landing page that shows the product on the first screen.</li>
      </ul>

      <H4>October 12, 2026</H4>
      <ul>
        <li>Photos loads what you're looking at first: thumbnails on screen before the rest, and the photo you open before anything else. A fast scroll no longer leaves you waiting.</li>
      </ul>

      <H4>October 6, 2026</H4>
      <ul>
        <li>Fixes now reach every hosted cloud on a schedule, even if its owner hasn't signed in for a while.</li>
        <li>Each cloud signs its own sessions with its own secret.</li>
        <li>Photos is lighter. The map and smart search, which never worked here, are hidden, and unused code is gone.</li>
      </ul>
    </>
  );
}
