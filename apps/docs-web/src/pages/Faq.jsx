import { H3, repo } from '../ui.jsx';

export default function Faq() {
  return (
    <>
      <H3>Can other people use my install?</H3>
      <p>
        No. An install has one owner: the account setup records, or the first one to sign in through the
        worker's own login. Other accounts in your Firebase project can't read anything on it.
      </p>

      <H3>Does it phone home?</H3>
      <p>
        No. Apart from Telegram and your own Firebase project, the only thing an install contacts is GitHub's
        public releases list, to check for updates when you open the dashboard. That request is anonymous and
        sends nothing about your install. There's no switch to turn it off yet: clearing{' '}
        <code>UPDATE_REPO</code> makes it check the default repository instead.
      </p>

      <H3>Is it really free?</H3>
      <p>
        Yes, within the free plans of Telegram, Cloudflare and Firebase. There is no paid version of
        self-hosting and no key to buy.
      </p>

      <H3>What if this project disappears?</H3>
      <p>
        You keep everything. Your files are in your Telegram channel, the index is in your D1 database, and
        the code is in your clone under AGPL-3.0. Nothing here can be switched off remotely.
      </p>

      <H3>Is the hosted service different from self-hosting?</H3>
      <p>
        It runs the same code. A few settings differ, such as which Firebase project it uses and which domain
        goes in links, and the features are the same. The one real difference is updates. We can push an update to a hosted install because we hold
        its credentials, and we deliberately can't push one to yours.
      </p>

      <H3>Why Telegram? Isn't that fragile?</H3>
      <p>
        Telegram is the only free, unlimited store of its kind, and the project is built on it. Paying for
        object storage would end the project. The trade-off is that your files live in a private channel you
        control, under Telegram's terms. Keep the bot in the channel and don't delete its messages, because
        those messages are your files.
      </p>

      <H3>Can I contribute?</H3>
      <p>
        Yes. Start with <a href={repo('CONTRIBUTING.md')}>CONTRIBUTING.md</a>. It explains where things live
        and the four hard limits behind most of the odd-looking code. Please don't test against anyone else's
        deployment, ours included. Self-hosting gives you a full setup of your own in about ten minutes.
      </p>
    </>
  );
}
