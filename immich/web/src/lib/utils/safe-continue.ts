// Where to send someone after signing in (or unlocking): a path inside this
// app, or the fallback. `continue` comes from the address bar, so anything that
// could leave the site — another origin, "//host", "/\host" (browsers read the
// backslash as a slash), a scheme, control characters — is refused.
export function safeContinue(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') {
    return fallback;
  }
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001F\u007F\\]/.test(value)) {
    return fallback;
  }
  return value;
}
