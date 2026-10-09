import fs from "node:fs";
import assert from "node:assert/strict";

const roots = process.argv.slice(2);
assert.ok(roots.length, "Δώσε τουλάχιστον έναν φάκελο web assets.");

for (const root of roots) {
  for (const [htmlName, jsName] of [["index.html", "app.js"], ["portal.html", "portal.js"]]) {
    const html = fs.readFileSync(`${root}/${htmlName}`, "utf8");
    const js = fs.readFileSync(`${root}/${jsName}`, "utf8");
    const htmlIds = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
    const requestedIds = [...js.matchAll(/getElementById\((?:"|')([^"']+)(?:"|')\)/g)].map((match) => match[1]);
    const missing = [...new Set(requestedIds)].filter((id) => !htmlIds.includes(id));
    const duplicated = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
    assert.deepEqual(missing, [], `${root}/${htmlName}: λείπουν HTML IDs: ${missing.join(", ")}`);
    assert.deepEqual(duplicated, [], `${root}/${htmlName}: διπλά HTML IDs: ${duplicated.join(", ")}`);
    console.log(`OK ${root}/${htmlName}: ${htmlIds.length} μοναδικά IDs`);
  }
}
