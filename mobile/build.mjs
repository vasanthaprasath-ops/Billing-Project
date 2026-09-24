// Assembles mobile/www - the web assets Capacitor packs into the Android app:
// the shared UI from ../web, the on-device backend from ./src, and the vendored runtimes
// (sql.js for SQLite, Capacitor core for native plugins). Run: npm run build
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const www = join(here, "www");
const nm = join(here, "node_modules");

rmSync(www, { recursive: true, force: true });
cpSync(join(here, "..", "web"), www, { recursive: true });

mkdirSync(join(www, "js", "local"), { recursive: true });
for (const f of ["pdf.js", "zip.js", "backend.js", "bridge.js", "m3.js", "feel.js"]) copyFileSync(join(here, "src", f), join(www, "js", "local", f));
copyFileSync(join(here, "src", "mobile.css"), join(www, "css", "mobile.css"));

mkdirSync(join(www, "vendor"), { recursive: true });
copyFileSync(join(nm, "sql.js", "dist", "sql-wasm.js"), join(www, "vendor", "sql-wasm.js"));
copyFileSync(join(nm, "sql.js", "dist", "sql-wasm.wasm"), join(www, "vendor", "sql-wasm.wasm"));
copyFileSync(join(nm, "@capacitor", "core", "dist", "capacitor.js"), join(www, "vendor", "capacitor.js"));

const indexPath = join(www, "index.html");
let html = readFileSync(indexPath, "utf8");
const replaceOnce = (from, to) => {
    if (!html.includes(from)) throw new Error("build.mjs: web/index.html no longer contains " + JSON.stringify(from));
    html = html.replace(from, to);
};
replaceOnce('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
replaceOnce('<link rel="stylesheet" href="/css/style.css">',
    '<link rel="stylesheet" href="/css/style.css">\n    <link rel="stylesheet" href="/css/mobile.css">');
replaceOnce('<script src="/js/app.js"></script>', [
    '<script src="/vendor/capacitor.js"></script>',
    '<script src="/vendor/sql-wasm.js"></script>',
    '<script src="/js/local/pdf.js"></script>',
    '<script src="/js/local/zip.js"></script>',
    '<script src="/js/local/backend.js"></script>',
    '<script src="/js/local/bridge.js"></script>',
    '<script src="/js/app.js"></script>',
    '<script src="/js/local/m3.js"></script>',
    '<script src="/js/local/feel.js"></script>',
].join("\n"));
writeFileSync(indexPath, html);
console.log("Built " + www);
