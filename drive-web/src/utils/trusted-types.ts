// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.
// The CSP requires Trusted Types (`require-trusted-types-for 'script'`). Vue
// and DOMPurify create their own named policies. Ace, video.js and epub.js
// still assign plain strings to HTML sinks; this default policy lets those
// through only after DOMPurify has cleaned them. It defines no createScript
// or createScriptURL, so string-built scripts and script URLs stay blocked.
import DOMPurify from "dompurify";

// The sink name Chromium passes for DOMParser. A parsed document is inert (its
// scripts never run, and adopted inline handlers are blocked by script-src),
// and epub.js parses a book's XML with it, which HTML sanitising destroys.
const DOMPARSER_SINK = "DOMParser parseFromString";

if (window.trustedTypes?.createPolicy) {
  // Claim the "dompurify" policy name now, so DOMPurify never falls back to
  // plain strings (which would route its own parsing through this policy).
  DOMPurify.sanitize("");
  let depth = 0;
  window.trustedTypes.createPolicy("default", {
    createHTML: (html: string, ...context: unknown[]) => {
      if (context.includes(DOMPARSER_SINK)) return html;
      if (depth > 0) return null; // re-entered: block rather than recurse
      depth++;
      try {
        return DOMPurify.sanitize(html);
      } finally {
        depth--;
      }
    },
  });
}
