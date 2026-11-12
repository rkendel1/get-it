/** Print the canonical digest of every contract file. Freezing = recording it in contracts/frozen.json. */
import { readdirSync, readFileSync } from "node:fs";
import { digest } from "../src/canonical.js";

const dir = new URL("../contracts/", import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.includes("@") && f.endsWith(".json")).sort()) {
  console.log(`${f.replace(/\.json$/, "")} ${digest(JSON.parse(readFileSync(new URL(f, dir), "utf8")))}`);
}
