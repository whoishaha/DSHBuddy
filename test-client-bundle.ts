// Client bundle contract test: simulate the dsh web shell's window.__ModuleLoader__,
// load lib/client.js, materialize the factory, and assert the plugin contract
// ({ apply, inject }) — the same path dsh-client-modules uses in the browser.
// Run: node --input-type=module (bundle is a classic script; evaluate via vm).

import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync("./lib/client.js", "utf8");

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  },
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });

if (!loaded) {
  console.error("FAIL  __ModuleLoader__.load was never called");
  process.exit(1);
}
console.log("PASS  load called with id:", loaded.id);

if (loaded.id !== "dshbuddy") {
  console.error("FAIL  unexpected id", loaded.id);
  process.exit(1);
}
console.log("PASS  id is dshbuddy");

// Materialize the factory with a stub require (react etc. resolve to stubs;
// component bodies only run at render time, so stubs suffice for contract check).
const exportsObj = {};
try {
  const result = loaded.factory((spec) => {
    if (spec === "react" || spec === "react/jsx-runtime") {
      return { useState: () => [], useEffect: () => {}, createElement: () => null, jsx: () => null, Fragment: null };
    }
    if (spec.startsWith("@deepseek-ai/")) return {};
    throw new Error(`unexpected require: ${spec}`);
  });
  exportsObj.result = result;
  const apply = result?.apply;
  const inject = result?.inject;
  console.log("PASS  factory executed");
  if (typeof apply !== "function") {
    console.error("FAIL  exports.apply is not a function:", typeof apply);
    process.exit(1);
  }
  console.log("PASS  exports.apply is a function");
  if (!Array.isArray(inject)) {
    console.error("FAIL  exports.inject is not an array");
    process.exit(1);
  }
  console.log("PASS  exports.inject:", JSON.stringify(inject));
  console.log("\nclient bundle contract OK");
  process.exit(0);
} catch (err) {
  console.error("FAIL  factory threw:", err.message);
  process.exit(1);
}
