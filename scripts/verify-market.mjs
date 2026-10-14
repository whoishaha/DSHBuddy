// Live market verification against https://petdex.dev (after host rebuild).
//   - GET  /api/dshbuddy/market           -> manifest list from petdex.dev
//   - POST /api/dshbuddy/market/install   -> downloads a real pet + spritesheet
// Run: node scripts/verify-market.mjs
import { apply } from "../lib/index.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Isolate ALL host writes (pets dir, config, notes...) into a temp HOME so the
// real ~/.petdex is untouched. The host reads homedir() at module load, so set
// this before importing lib/index.js.
const realHome = homedir();
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), "dshbuddy-market-test-"));
process.env.HOME = process.env.USERPROFILE;
// Node resolves os.homedir() lazily? It caches at first call — force re-eval by
// re-requiring the module via a fresh import path is not possible for ESM, so
// instead we pre-empt: the pets module reads homedir() at apply() time.
// Guard: if it still resolves to the real home, abort.
if (homedir() === realHome) {
  console.error("FAIL  could not redirect homedir() for isolated test; aborting");
  process.exit(1);
}
console.log("test homedir:", homedir());

const disposers = [];
const routes = [];
const ctx = {
  on() {},
  get(name) {
    if (name === "webServer") {
      return {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      };
    }
    return undefined;
  },
};
apply(ctx);

function makeRes() {
  const r = { status: 0, payload: "" };
  return {
    res: {
      writeHead(s) { r.status = s; },
      end(data) { r.payload = data ?? ""; },
    },
    read: () => r,
  };
}

/** Drive one route; poll until the handler settles (async fetch) or timeout. */
async function drive(method, pathname, body, timeoutMs = 30_000) {
  const handler = routes.find((rt) => pathname.startsWith(rt.path))?.handler;
  if (!handler) return { status: 404, payload: "" };
  const { res, read } = makeRes();
  const req = {
    method,
    url: pathname,
    on(ev, cb) { if (ev === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === "end") cb(); },
    destroy() {},
  };
  handler(req, res);
  const start = Date.now();
  while (read().payload === "" && Date.now() - start < timeoutMs) {
    await new Promise((r2) => setTimeout(r2, 120));
  }
  const { status, payload } = read();
  let json = payload;
  if (typeof payload === "string" && payload) { try { json = JSON.parse(payload); } catch {} }
  return { status, json };
}

const checks = [];
function check(name, pass, detail = "") {
  checks.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

// 1. Market list from petdex.dev
const list = await drive("GET", "/api/dshbuddy/market");
check("market list 200", list.status === 200 && list.json?.ok === true, `status=${list.status}`);
const pets = list.json?.pets ?? [];
check("market has pets", pets.length > 0, `count=${pets.length}`);
check("market entries shaped", pets.every((p) => p.slug && p.displayName), `first=${pets[0]?.slug}`);

// 2. Install a real pet (pick a stable, small-ish slug from the manifest)
const target = pets.find((p) => p.slug === "whaledou") ?? pets[0];
const install = await drive("POST", "/api/dshbuddy/market/install", { slug: target.slug }, 60_000);
check(`install ${target.slug} ok`, install.status === 200 && install.json?.ok === true, `status=${install.status}`);

const petDir = join(homedir(), ".petdex", "pets", target.slug);
const files = existsSync(petDir) ? readdirSync(petDir) : [];
check("pet dir created", existsSync(petDir), petDir);
check("pet.json written", files.includes("pet.json"), `files=${files.join(",")}`);
const hasSheet = files.some((f) => f.startsWith("spritesheet."));
check("spritesheet written", hasSheet, `files=${files.join(",")}`);
if (files.includes("pet.json")) {
  const meta = JSON.parse(readFileSync(join(petDir, "pet.json"), "utf8"));
  check("pet.json parseable + named", Boolean(meta.id && meta.displayName), `id=${meta.id} name=${meta.displayName}`);
}

// 3. Cleanup so the isolated test never pollutes the real pets dir
try { rmSync(petDir, { recursive: true, force: true }); } catch {}

const failed = checks.filter((p) => !p).length;
console.log(`\n${checks.length - failed}/${checks.length} market checks passed`);
process.exit(failed === 0 ? 0 : 1);
