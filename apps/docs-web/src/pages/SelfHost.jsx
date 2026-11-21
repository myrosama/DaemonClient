import { H3, H4, Note, Table, repo } from '../ui.jsx';

const QUICK = `git clone https://github.com/myrosama/DaemonClient.git
cd DaemonClient
(cd workers/user-worker && npm install) && (cd selfhost && npm ci)
node selfhost/bin/daemonclient.mjs setup`;

const SITES = `https://<project>.web.app          ← dashboard (open this one)
https://<project>-photos.web.app   ← Photos
https://<project>-drive.web.app    ← Drive`;

export default function SelfHost() {
  return (
    <>
      <p>
        You can run all of DaemonClient on accounts you own. Setup takes about ten minutes, and most of that
        is spent clicking through Telegram and Cloudflare.
      </p>

      <H3 id="what-you-need">What you need</H3>
      <Table
        head={['Account or tool', 'What it does']}
        rows={[
          ['A Telegram bot and a private channel', 'Stores your files.'],
          ['A Cloudflare account on the free plan', 'Runs your worker and D1 database, which together are the API.'],
          ['A Firebase project', 'Handles your sign-in.'],
          ['Node.js 22.13 or newer', <>Runs the setup tool on your computer. <code>install.sh</code> fetches a private copy if yours is older.</>],
        ]}
      />
      <p>Firebase Hosting, also free, can serve the web apps. That's covered in step 5.</p>

      <H3 id="quick-start">Quick start</H3>
      <p>
        Setup is one guided command. It asks for each credential in turn, tells you where to find it and
        checks it against the real service before moving on. It saves after every step, so you can stop at
        any point and run it again to carry on.
      </p>
      <pre>{QUICK}</pre>
      <p>
        When it finishes it prints your API address, for example{' '}
        <code>https://daemonclient-a1b2c3.yourname.workers.dev</code>. That address is your server.
      </p>
      <Note>
        <p>
          The rest of this page writes commands as <code>daemonclient &lt;command&gt;</code>. Run them as{' '}
          <code>node selfhost/bin/daemonclient.mjs &lt;command&gt;</code>, or run <code>npm link</code> once
          inside <code>selfhost/</code> to get the short form.
        </p>
      </Note>

      <H3 id="steps">Setup, step by step</H3>
      <p>
        This is what <code>daemonclient setup</code> walks you through, for anyone who wants to understand
        each credential before running it.
      </p>

      <H4 id="telegram">1. Telegram: where your files live</H4>
      <p>
        Message <a href="https://t.me/botfather">@BotFather</a>, send <code>/newbot</code>, answer its two
        questions and copy the token. It looks like <code>12345:AAH…</code>.
      </p>
      <p>
        Then create a new private channel and add your bot as an administrator that can post, edit and
        delete messages. To find the channel ID, which looks like <code>-1001234567890</code>, forward any
        message from the channel to <a href="https://t.me/userinfobot">@userinfobot</a>.
      </p>
      <Note>
        <p>
          Setup posts a test message to the channel and deletes it again. A bot can be a member of a channel
          and still be unable to post there, and it's better to find that out now than on your first upload.
        </p>
      </Note>

      <H4 id="cloudflare">2. Cloudflare: where the API runs</H4>
      <p>
        At <a href="https://dash.cloudflare.com/profile/api-tokens">dash.cloudflare.com/profile/api-tokens</a>,
        create a Custom Token with these permissions:
      </p>
      <Table
        head={['Type', 'Item', 'Permission']}
        rows={[
          ['Account', 'Workers Scripts', 'Edit'],
          ['Account', 'D1', 'Edit'],
          ['Account', 'Account Settings', 'Read'],
          ['Account', 'Cloudflare Pages', <>Edit, only if you'll use <code>daemonclient dashboard</code></>],
        ]}
      />
      <Note>
        <p>
          <strong>Don't use a Global API Key.</strong> The custom token can create your worker and database
          and nothing else. Setup keeps it in a local file only you can read (mode 0600) and sends it to
          Cloudflare and nowhere else.
        </p>
      </Note>

      <H4 id="firebase">3. Firebase: your sign-in</H4>
      <p>
        If the Firebase CLI is installed and signed in, setup creates the project, the web app and your
        account for you. Otherwise, at <a href="https://console.firebase.google.com">console.firebase.google.com</a>,
        add a project (you don't need Analytics), then:
      </p>
      <ul>
        <li>In <em>Build &gt; Authentication</em>, click <em>Get started</em> and enable <strong>Email/Password</strong>.</li>
        <li>In <em>Authentication &gt; Users</em>, click <em>Add user</em>. This is your login.</li>
        <li>In <em>Project settings &gt; General &gt; Your apps</em>, register a <strong>Web app</strong> and copy its <code>apiKey</code> and <code>projectId</code>.</li>
      </ul>
      <p>
        Setup signs in for real to check these details, so a typo or a provider you haven't enabled yet
        shows up now instead of the first time you open Photos.
      </p>
      <Note>
        <p>
          <strong>There's no sign-up page.</strong> Accounts exist only in your own Firebase project. Firebase
          allows anyone to register by default, and like every Firebase app yours puts its Web API key in the
          browser, so a stranger can create an account. They still can't reach your files: an install
          belongs to one account, and every signed-in route checks it. If you'd rather strangers couldn't
          register at all, turn off self-registration in the Firebase console under{' '}
          <em>Authentication &gt; Settings</em>.
        </p>
      </Note>

      <H4 id="deploy">4. Deploy the worker and make your keys</H4>
      <p>
        Setup builds the worker from your checkout, deploys it to your Cloudflare account with your D1
        database attached, saves your Telegram settings and makes your encryption keys. The keys are made
        once and reused on every later deploy. A new key would make the files already in Telegram
        unreadable, and a new session secret would sign you out.
      </p>
      <H4 id="web">5. The web apps</H4>
      <p>
        There are three web apps: the <strong>dashboard</strong>, where you sign in and then open Photos or
        Drive, <strong>Photos</strong> and <strong>Drive</strong>. One command builds all three from your
        checkout, points each at your worker and your Firebase project, and deploys them to Firebase Hosting
        on your own project, which is free:
      </p>
      <pre>daemonclient web</pre>
      <p>
        It builds the apps, creates three Firebase Hosting sites, deploys them and adds their addresses to
        your worker's <code>ALLOWED_ORIGINS</code>. Firebase Hosting signs in with your own Google account
        (<code>firebase login</code> opens a browser), and nothing reaches us. You end up with:
      </p>
      <pre>{SITES}</pre>
      <p>
        To build them yourself, give each app your worker's address at build time. An app only falls back
        to our address when it isn't built for self-hosting, so a self-host build never points at us.
      </p>
      <Table
        head={['App', 'Build with']}
        rows={[
          ['Photos', <code>PUBLIC_SELF_HOST=1 PUBLIC_DAEMONCLIENT_WORKER_URL=&lt;worker&gt; npm run build</code>],
          ['Drive', <code>VITE_SELF_HOST=1 VITE_API_BASE=&lt;worker&gt; npm run build</code>],
          ['Dashboard', <code>VITE_SELF_HOST=1 VITE_API_BASE=&lt;worker&gt; VITE_FIREBASE_*=… npx vite build --mode selfhost</code>],
        ]}
      />
      <p>Phone apps for iPhone and Android are being built on the same core. Until they ship, use the web apps.</p>

      <H3 id="commands">Commands</H3>
      <Table
        head={['Command', 'What it does']}
        rows={[
          [<code>daemonclient setup</code>, 'Creates your cloud: Telegram, Cloudflare, your account and the first deploy.'],
          [<code>daemonclient web</code>, 'Builds the three web apps and deploys them to your Firebase project.'],
          [<code>daemonclient dashboard</code>, 'Builds only the dashboard and publishes it to Cloudflare Pages.'],
          [<code>daemonclient status</code>, "Shows what's running and whether it's healthy."],
          [<code>daemonclient update</code>, 'Rebuilds from your current source and redeploys.'],
          [<code>daemonclient doctor</code>, 'Checks a broken install and prints a report with every secret removed.'],
        ]}
      />

      <H3 id="updating">Updating</H3>
      <p>
        When you run <code>daemonclient status</code>, your worker checks GitHub for a newer release (at most
        every 12 hours), and the command tells you if there is one. No release has been published yet. The worker never updates itself
        and never contacts us; when to update is up to you. To update:
      </p>
      <pre>{`git pull
daemonclient update`}</pre>
      <p>
        <code>update</code> applies any new database changes, rebuilds from the source in your folder and
        redeploys. It reuses your existing secrets, so your files, database and sign-in stay as they are.
      </p>
      <Note>
        <p>
          The hosted service and self-hosted installs run the same code. A fix is written once: we push it to
          hosted installs, and self-hosted installs get it with <code>git pull</code> and{' '}
          <code>daemonclient update</code>.
        </p>
      </Note>

      <H3 id="troubleshooting">Troubleshooting</H3>
      <p>
        Start with <code>daemonclient doctor</code>. It checks every part, tells you what to run for each
        problem and removes every secret from its output, so the report is safe to paste into an issue.
      </p>
      <Table
        head={['Problem', 'Cause and fix']}
        rows={[
          ['A web app says "Cannot reach the server"', <>The app's address isn't in <code>ALLOWED_ORIGINS</code>. Run <code>daemonclient web</code> again, or add the address to your worker's variables.</>],
          ['Photos or videos have blank thumbnails', <>In Photos, open <em>Utilities</em> and run <em>Fix HEIC &amp; missing thumbnails</em>, then <em>Fix video thumbnails</em>. Both make the thumbnails in your browser.</>],
          ['Everything worked, then stopped', "Check Cloudflare's free-plan limits: 100,000 worker requests a day, and D1 has its own allowances. Browsing a big library hard can reach them."],
        ]}
      />
      <p>
        The full guide, with every option, is <a href={repo('docs/SELF_HOSTING.md')}>docs/SELF_HOSTING.md</a>.
      </p>
    </>
  );
}
