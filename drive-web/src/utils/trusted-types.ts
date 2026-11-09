// The CSP requires Trusted Types (`require-trusted-types-for 'script'`). Vue
// and DOMPurify create their own named policies. Ace, video.js and epub.js
// still assign plain strings to HTML sinks (innerHTML, srcdoc); this default
// policy lets those through only after DOMPurify has cleaned them. It defines
// no createScript or createScriptURL, so string-built scripts stay blocked.
import DOMPurify from "dompurify";

if (window.trustedTypes?.createPolicy) {
  window.trustedTypes.createPolicy("default", {
    createHTML: (html: string) => DOMPurify.sanitize(html),
  });
}
