import { useEffect, useState } from 'react';
import { getDavStatus, createDavMount, revokeDavMount, getUserEmail } from './api.js';

// "Connect as a drive" — generate a WebDAV mount URL + credentials so the user
// can mount their Drive in any OS file manager (GNOME / macOS Finder / Windows /
// iOS Files) or rclone. Additive UI; nothing else in Drive is changed.
export default function ConnectDriveModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null); // { enabled, url, username }
  const [creds, setCreds] = useState(null); // { token, username, url } — shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getDavStatus().then(setStatus).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function generate() {
    setBusy(true); setError('');
    try {
      const c = await createDavMount();
      setCreds(c);
      setStatus({ enabled: true, url: c.url, username: c.username });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function revoke() {
    setBusy(true); setError('');
    try { await revokeDavMount(); setCreds(null); setStatus({ enabled: false }); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const url = creds?.url || status?.url || '';
  // The mount token is the only credential checked — the username is ignored by
  // the server, so we show the user's email (friendlier than the raw worker uid).
  const username = getUserEmail() || creds?.username || status?.username || '';
  const password = creds?.token || '';
  const davs = url.replace(/^https:\/\//, 'davs://');

  const copy = (t) => navigator.clipboard?.writeText(t);
  const S = styles;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.header}>
          <span style={S.title}>Connect as a drive</span>
          <button style={S.x} onClick={onClose}>×</button>
        </div>
        <p style={S.sub}>Mount your Drive in your file manager — like a network drive. No app to install.</p>

        {loading ? (
          <p style={S.muted}>Loading…</p>
        ) : (
          <>
            {!status?.enabled && !creds && (
              <button style={S.primary} disabled={busy} onClick={generate}>
                {busy ? 'Generating…' : 'Generate mount link'}
              </button>
            )}

            {(status?.enabled || creds) && (
              <div style={S.box}>
                <Field label="Server (https — Finder / apps / rclone)" value={url} onCopy={() => copy(url)} S={S} />
                <Field label="Username" value={username} onCopy={() => copy(username)} S={S} />
                {creds ? (
                  <Field label="Password (shown once — save it!)" value={password} onCopy={() => copy(password)} S={S} highlight />
                ) : (
                  <p style={S.muted}>Password was shown when you generated it. Lost it? Regenerate below.</p>
                )}
              </div>
            )}

            {(status?.enabled || creds) && (
              <div style={S.instructions}>
                <p style={S.instrNote}>Each app needs the URL in its own format — use the <b>Copy</b> button next to your platform (don't reuse the <code>https://</code> URL above for GNOME). When prompted, sign in with your <b>email</b> (above) and the <b>password</b>.</p>
                <Instr title="GNOME Files / Nautilus" hint={<>Other Locations → “Connect to Server”, paste:</>} value={davs} S={S} />
                <Instr title="macOS Finder" hint={<>Go → Connect to Server (⌘K), paste:</>} value={url} S={S} />
                <Instr title="Windows Explorer" hint={<>Map network drive → Folder, paste:</>} value={url} S={S} />
                <Instr
                  title="iPhone / iPad — NOT Apple's Files app"
                  hint={<><b style={{ color: '#f87171' }}>iOS Files will reject this URL</b> — Apple only supports SMB there, never WebDAV. Install the free <b>Documents by Readdle</b> app → tap <b>+</b> → <b>Add Connection</b> → <b>Connect to Server</b> → paste the URL below, then your email + password:</>}
                  value={url} S={S}
                />
                <Instr title="rclone" hint={<>Mount from a terminal:</>} value={`rclone mount :webdav,url=${url},user=${username},pass=YOUR_PASSWORD mnt`} S={S} />
                <p style={S.instrFoot}>Your file manager labels the mount by its web address (e.g. “dc-…workers.dev”). To rename it: in GNOME right-click the sidebar entry → <b>Rename</b>; in Finder/Documents rename the bookmark.</p>
              </div>
            )}

            {error && <p style={S.error}>{error}</p>}

            {(status?.enabled || creds) && (
              <div style={S.row}>
                <button style={S.secondary} disabled={busy} onClick={generate}>Regenerate</button>
                <button style={S.danger} disabled={busy} onClick={revoke}>Revoke access</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onCopy, S, highlight }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.label}>{label}</div>
      <div style={{ ...S.field, ...(highlight ? S.fieldHi : {}) }}>
        <span style={S.fieldVal}>{value}</span>
        <button style={S.copy} onClick={onCopy}>Copy</button>
      </div>
    </div>
  );
}
function Instr({ title, hint, value, S }) {
  const copy = () => navigator.clipboard?.writeText(value);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.instrTitle}>{title}</div>
      <div style={S.instrBody}>{hint}</div>
      <div style={S.field}>
        <span style={S.fieldVal}>{value}</span>
        <button style={S.copy} onClick={copy}>Copy</button>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#15171c', color: '#e7e9ee', width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto', borderRadius: 14, border: '1px solid rgba(255,255,255,0.08)', padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 17, fontWeight: 600 },
  x: { background: 'none', border: 'none', color: '#9aa0ab', fontSize: 24, cursor: 'pointer', lineHeight: 1 },
  sub: { color: '#9aa0ab', fontSize: 13, marginTop: 4, marginBottom: 16 },
  muted: { color: '#9aa0ab', fontSize: 13 },
  primary: { width: '100%', background: '#22c55e', color: '#06210f', border: 'none', borderRadius: 10, padding: '12px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  secondary: { flex: 1, background: 'rgba(255,255,255,0.06)', color: '#e7e9ee', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', cursor: 'pointer' },
  danger: { flex: 1, background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '10px 14px', cursor: 'pointer' },
  box: { background: '#0f1115', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 14, marginBottom: 14 },
  label: { fontSize: 11, color: '#9aa0ab', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  field: { display: 'flex', alignItems: 'center', gap: 8, background: '#070809', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '8px 10px' },
  fieldHi: { borderColor: 'rgba(34,197,94,0.5)' },
  fieldVal: { flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' },
  copy: { background: 'rgba(255,255,255,0.08)', color: '#e7e9ee', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  instructions: { background: '#0f1115', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 14, marginBottom: 14 },
  instrNote: { fontSize: 12, color: '#e7b450', marginTop: 0, marginBottom: 12, lineHeight: 1.4 },
  instrFoot: { fontSize: 11, color: '#9aa0ab', marginTop: 10, marginBottom: 0, lineHeight: 1.4, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 },
  instrTitle: { fontSize: 13, fontWeight: 600, marginBottom: 2 },
  instrBody: { fontSize: 12, color: '#b9bec9' },
  row: { display: 'flex', gap: 10 },
  error: { color: '#f87171', fontSize: 13, marginBottom: 10 },
};
