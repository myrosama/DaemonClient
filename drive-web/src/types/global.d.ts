// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.
export {};

declare global {
  interface Window {
    // Trusted Types (Chromium); only what utils/trusted-types.ts uses.
    trustedTypes?: {
      createPolicy(
        name: string,
        rules: { createHTML?: (input: string) => string }
      ): unknown;
    };
  }

  interface HTMLElement {
    // TODO: no idea what the exact type is
    __vue__: any;
  }

  interface HTMLElement {
    clickOutsideEvent?: (event: Event) => void;
  }
}
