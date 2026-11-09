// Vite plugin: writes THIRD_PARTY_LICENSES.txt into the build output with the
// name, version, licence and licence/notice files of every production
// dependency (Apache-2.0 §4 and the MIT/BSD notices; FILEBROWSER_SPEC.md §2).
// It lists all production dependencies, a superset of what the bundle uses.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LEGAL_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

// `extra`: code not installed by pnpm, e.g. [{ name, license, file }] with
// `file` relative to the project root.
export function thirdPartyLicenses(extra = []) {
  let root;
  let outDir;
  return {
    name: "third-party-licenses",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const groups = JSON.parse(
        execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      );
      const packages = Object.values(groups)
        .flat()
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!packages.some((p) => p.name === "vue")) {
        throw new Error("third-party-licenses: pnpm listed no vue; refusing to write an incomplete file");
      }
      const sections = extra.map(
        (e) => `${e.name} — ${e.license}\n\n${readFileSync(path.resolve(root, e.file), "utf8").trim()}`
      );
      sections.push(...packages.map((p) => {
        const dir = p.paths[0];
        const files = readdirSync(dir).filter((f) => LEGAL_FILE.test(f)).sort();
        const texts = files.map((f) => readFileSync(path.join(dir, f), "utf8").trim());
        const body = texts.length ? texts.join("\n\n") : `(The package ships no licence file; its package.json declares ${p.license}.)`;
        return `${p.name} ${p.versions.join(", ")} — ${p.license}\n\n${body}`;
      }));
      writeFileSync(
        path.join(outDir, "THIRD_PARTY_LICENSES.txt"),
        `Third-party software in DaemonClient Drive (drive-web)\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`
      );
    },
  };
}
