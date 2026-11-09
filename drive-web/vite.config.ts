// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.
import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";

// A plain static build served from drive.daemonclient.uz/next/. No legacy
// plugin: its inline loader scripts would need 'unsafe-inline' in the CSP.
export default defineConfig({
  base: "/next/",
  plugins: [
    vue(),
    VueI18nPlugin({
      include: [path.resolve(__dirname, "./src/i18n/**/*.json")],
    }),
  ],
  resolve: {
    alias: {
      "@/": `${path.resolve(__dirname, "src")}/`,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // one chunk for dayjs and one for i18n, not a file per locale
          if (id.includes("dayjs/")) return "dayjs";
          if (id.includes("i18n/")) return "i18n";
        },
      },
    },
  },
});
