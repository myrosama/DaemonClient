// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.
// Static build: these were filled in by File Browser's Go server.
const name = "DaemonClient Drive";
const disableExternal = false;
// Storage has no fixed total, so a "used of total" bar means nothing.
const disableUsedPercentage = true;
// Vite's base is "/next/"; the router and URLs want it without the slash.
const baseURL: string = import.meta.env.BASE_URL.replace(/\/$/, "");
const version = "beta";
const logoURL = `${baseURL}/img/logo.svg`;
const theme: UserTheme = "";
const enableThumbs = true;
const resizePreview = true;
const origin = window.location.origin;

export {
  name,
  disableExternal,
  disableUsedPercentage,
  baseURL,
  logoURL,
  version,
  theme,
  enableThumbs,
  resizePreview,
  origin,
};
