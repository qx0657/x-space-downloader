// Copies third-party browser bundles into src/vendor/ so the extension loads unpacked
// without a build step. Run after upgrading mux.js.
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("src/vendor", { recursive: true });
await copyFile("node_modules/mux.js/dist/mux-mp4.min.js", "src/vendor/mux-mp4.min.js");
await copyFile("node_modules/mux.js/LICENSE", "src/vendor/mux.js.LICENSE");
console.log("vendored mux.js -> src/vendor/");
