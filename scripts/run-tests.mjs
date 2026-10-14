// DSHBuddy test runner: bundles and executes the offline verification suites.
// Each suite runs against a THROWAWAY data root (DSHBUDDY_DATA_DIR) so tests
// never pollute the real ~/.petdex runtime (orders, care log, notes…).
// NOTE: paths.ts migrates ~/.petdex into an EMPTY override root, so we
// pre-create <root>/runtime to make the override count as initialized.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const esbuild = join(process.cwd(), "node_modules", "esbuild", "bin", "esbuild");
// Mirror build.mjs's version define so bundles referencing __DSHBUDDY_VERSION__
// also run correctly under test.
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "dshbuddy-test-"));
const tmpData = mkdtempSync(join(tmpdir(), "dshbuddy-test-data-"));
mkdirSync(join(tmpData, "runtime"), { recursive: true });

// Always rebuild first. The suites exercise lib/ exactly as DSH loads it, but
// must never pass against ignored, stale artifacts from an earlier source tree.
execFileSync(process.execPath, [join(process.cwd(), "build.mjs")], {
  stdio: "inherit",
});

function run(name, entry, out) {
  const outFile = join(tmp, out);
  console.log(`\n=== ${name} ===`);
  execFileSync(process.execPath, [
    esbuild,
    entry,
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${outFile}`,
    "--external:node:*",
    `--define:__DSHBUDDY_VERSION__=${JSON.stringify(version)}`,
  ], {
    stdio: "inherit",
  });
  execFileSync(process.execPath, [outFile], {
    stdio: "inherit",
    env: { ...process.env, DSHBUDDY_DATA_DIR: tmpData },
  });
}

try {
  run("host API integration", "test-host-api.ts", "host.mjs");
  run("client bundle contract", "test-client-bundle.ts", "client.mjs");
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tmpData, { recursive: true, force: true });
}
console.log("\nAll offline suites passed.");
