// Signed-in visitors skip the landing page and go straight to the app.
// Mirrors the session check in src/api.js (key + 7-day exp). Loaded
// synchronously in <head>, so it runs before paint, without a flash of the
// landing. A file rather than an inline script: the site's CSP forbids inline.
try {
  var dcS = JSON.parse(localStorage.getItem('dc_drive_session') || 'null');
  if (dcS && (!dcS.exp || dcS.exp > Date.now())) location.replace('/dashboard');
} catch (e) {}
