/** Print the canonical digest of every contract file and its pin. Freezing = recording it in contracts/frozen.json. */
import { readdirSync, readFileSync } from "node:fs";
import { digest } from "../src/canonical.js";
import { PINS } from "../src/contract.js";

const dir = new URL("../contracts/", import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.includes("@") && f.endsWith(".json")).sort()) {
  const key = f.replace(/\.json$/, "");
  const actual = digest(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  const pin = PINS[key];
  console.log(`${key} ${actual} ${pin ? (pin.digest === actual ? `pinned (${pin.status})` : `CHANGED: pinned ${pin.digest}`) : "not frozen"}`);
}
for (const [key, pin] of Object.entries(PINS)) if (pin.status === "retired") console.log(`${key} ${pin.digest} retired ${pin.retiredOn ?? ""}`);
