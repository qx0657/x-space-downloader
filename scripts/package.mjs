// Builds dist/x-space-downloader-<version>.zip for the Chrome Web Store.
// package.json is the source of truth for the version; manifest.json must match.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (pkg.version !== manifest.version) {
  console.error(`Version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
  process.exit(1);
}

const out = `dist/x-space-downloader-${pkg.version}.zip`;
await mkdir("dist", { recursive: true });
await rm(out, { force: true });
execFileSync("zip", ["-r", "-q", out, "manifest.json", "_locales", "icons", "src", "-x", "*.DS_Store"], {
  stdio: "inherit",
});
console.log(`wrote ${out}`);
