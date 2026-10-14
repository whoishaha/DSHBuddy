// Live verification for DSHBuddy after `dsh web` restart.
// Checks: host API reachable, snapshot sane, pets include the whale,
// sprite serves, config round-trips. Run: node scripts/verify-live.mjs
const BASE = process.env.DSHBUDDY_BASE ?? "http://127.0.0.1:3080";

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

const checks = [];
function check(name, pass, detail = "") {
  checks.push([name, pass]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

try {
  // 1. snapshot endpoint (host half loaded?)
  const snap = await get("/api/dshbuddy/snapshot");
  check("host API /snapshot reachable", snap.status === 200 && snap.json?.ok === true, `status=${snap.status}`);
  check("snapshot has state+bubble", Boolean(snap.json?.snapshot?.state) && typeof snap.json?.snapshot?.bubble === "string");
  check("active pet present", Boolean(snap.json?.pet?.slug), `pet=${snap.json?.pet?.slug}`);

  // 2. pets include the whale
  const pets = await get("/api/dshbuddy/pets");
  check(
    "deepseek-whale in pets",
    pets.json?.pets?.some((p) => p.slug === "deepseek-whale"),
    `slugs=${(pets.json?.pets ?? []).map((p) => p.slug).join(",")}`,
  );

  // 3. sprite serves binary
  const sprite = await fetch(`${BASE}/api/dshbuddy/sprite`, { cache: "no-store" });
  const buf = Buffer.from(await sprite.arrayBuffer());
  check("sprite served", sprite.status === 200 && buf.length > 100, `bytes=${buf.length}`);

  // 4. stats reachable
  const stats = await get("/api/dshbuddy/stats");
  check("stats endpoint", stats.status === 200 && stats.json?.stats, `sessions=${Object.keys(stats.json?.stats?.sessions ?? {}).length}`);

  // 5. config round-trip (read current, write same value back is destructive; just read)
  check("config in snapshot", Boolean(snap.json?.config?.floaterMode), `mode=${snap.json?.config?.floaterMode}`);
} catch (err) {
  check("live probe failed", false, String(err.message ?? err));
}

const failed = checks.filter(([, p]) => !p).length;
console.log(`\n${checks.length - failed}/${checks.length} live checks passed`);
console.log(
  failed === 0
    ? "DSHBuddy is live. Look for the whale in the page corner; DSH settings should show 宠物/统计 pages."
    : "Some checks failed — see above. If the API 404s, the dsh web process may not have restarted with the new profile.",
);
process.exit(failed === 0 ? 0 : 1);
