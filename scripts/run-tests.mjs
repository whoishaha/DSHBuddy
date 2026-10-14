// DSHBuddy test runner: transpiles and executes the offline verification suites.
// Each suite runs against a THROWAWAY data root (DSHBUDDY_DATA_DIR) so tests
// never pollute the real ~/.petdex runtime (orders, care log, notes…).
// NOTE: paths.ts migrates ~/.petdex into an EMPTY override root, so we
// pre-create <root>/runtime to make the override count as initialized.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

// Mirror build.mjs's version define so bundles referencing __DSHBUDDY_VERSION__
// also run correctly under test.
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const tmpData = mkdtempSync(join(tmpdir(), "dshbuddy-test-data-"));
mkdirSync(join(tmpData, "runtime"), { recursive: true });

// Always rebuild first. The suites exercise lib/ exactly as DSH loads it, but
// must never pass against ignored, stale artifacts from an earlier source tree.
execFileSync(process.execPath, [join(process.cwd(), "build.mjs")], {
  stdio: "inherit",
});

function run(name, entry, out) {
  const outFile = join(process.cwd(), `.dshbuddy-test-${out}`);
  console.log(`\n=== ${name} ===`);
  try {
    buildSync({
      entryPoints: [entry],
      format: "esm",
      platform: "node",
      outfile: outFile,
      define: { __DSHBUDDY_VERSION__: JSON.stringify(version) },
      logLevel: "info",
    });
    execFileSync(process.execPath, [outFile], {
      stdio: "inherit",
      env: { ...process.env, DSHBUDDY_DATA_DIR: tmpData },
    });
  } finally {
    rmSync(outFile, { force: true });
  }
}

try {
  run("host API integration", "test-host-api.ts", "host.mjs");
  run("client bundle contract", "test-client-bundle.ts", "client.mjs");
} finally {
  rmSync(tmpData, { recursive: true, force: true });
}
console.log("\nAll offline suites passed.");
