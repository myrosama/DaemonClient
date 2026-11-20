import { H3, Note } from '../ui.jsx';

export default function Security() {
  return (
    <>
      <p>What is encrypted where, who can read it, and what you have to keep safe.</p>

      <H3>Who can read your files</H3>
      <ul>
        <li>
          Drive encrypts each file in your browser before upload. By default the key is kept
          in your own D1 database so your other devices and the drive mount can use it. Files you add through the mount
          are encrypted by your worker with that key. If you choose a custom password instead, it is never
          stored or sent, and only your browser can decrypt your files.
        </li>
        <li>
          Photos keeps its key in your own D1 database and stores your photos encrypted in your channel.
          Holding the key lets your worker work out checksums and read photo details, and that worker serves
          only you.
        </li>
        <li>
          An install has one owner. Self-host setup records your account as the owner, and an install without
          one is claimed by the first sign-in through the worker's own password login. Every signed-in route
          checks that owner, so another account in your Firebase project
          can't read your data.
        </li>
        <li>
          Your files never pass through a server we share between users. Work that needs real
          CPU, such as decoding HEIC photos, runs in your own browser.
        </li>
      </ul>

      <H3>On a self-hosted install, keep these safe</H3>
      <p>
        Your <strong>encryption keys</strong> are in your D1 database, not in the state file: the Photos key
        as <code>zke_password</code> and <code>zke_salt</code>, and Drive's under <code>drive_zke</code>.{' '}
        <code>daemonclient doctor --show-keys</code> prints the Photos key. To keep Drive's too, back up the
        D1 database itself, for example with <code>wrangler d1 export</code>. A custom Drive password exists
        only in your head. The other thing to keep is <strong>the Telegram channel itself</strong>, because its
        messages are your files.
      </p>
      <p>
        <code>.daemonclient-selfhost.json</code> (mode 0600, ignored by git) holds your tokens and session
        secret. It's worth keeping, but it can't decrypt anything.
      </p>
      <Note>
        <p>If you lose the key, the files already stored can't be decrypted. There is no backdoor.</p>
      </Note>
    </>
  );
}
