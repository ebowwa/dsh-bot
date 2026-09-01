// drift-moving-tag.test.mjs — the tag drift-check advances must be the tag
// consumers pin. Code and docs cannot drift apart here again.
//
// Regression anchor: issue #38. drift-check.yml advanced an undocumented
// bare 'v' while every consumer shell (examples/) and the README pin '@v1'
// — the v1 tag sat frozen at v1.0.9 through 33 releases (v1.10.0..v1.42.0)
// while drift-check ran green on every push: the propagation it exists for
// never happened. These tests fail without the fix — revert the tag-advance
// line to `git tag -f v "$NEXT" && git push -q -f origin v` and this suite
// goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

/** Every `uses: ebowwa/dsh-bot/...@TAG` pin in examples/. */
const examplePins = () => {
  const pins = [];
  for (const f of readdirSync(path.join(ROOT, "examples")).filter((n) => n.endsWith(".yml"))) {
    const text = read("examples", f);
    for (const m of text.matchAll(
      /^.*uses:\s*ebowwa\/dsh-bot\/\.github\/workflows\/\S+@(\S+)\s*$/gm,
    )) {
      pins.push({ file: f, tag: m[1] });
    }
  }
  return pins;
};

/** The pin the README documents ("Consumers pin `@v1`"). */
const readmePin = () => {
  const m = read("README.md").match(/pin `@(v[\w.-]+)`/);
  assert.ok(m, 'README must document the consumer pin ("Consumers pin `@v1`")');
  return m[1];
};

test("examples pin one moving major tag and the README documents the same pin", () => {
  const pins = examplePins();
  assert.ok(pins.length >= 3, `all example shells must pin a dsh-bot workflow (found ${pins.length})`);
  const tags = [...new Set(pins.map((p) => p.tag))];
  assert.equal(tags.length, 1, `examples must agree on one pin, found: ${tags.join(", ")}`);
  assert.match(tags[0], /^v\d+$/, "the pin must be a moving major tag (v<digits>), not a frozen release");
  assert.equal(readmePin(), tags[0], "README pin and example pins must be the same tag");
});

test("drift-check.yml advances the documented moving tag (issue #38 revert guard)", () => {
  const wf = read(".github", "workflows", "drift-check.yml");
  // the moving tag is derived from the same MAJOR that builds the release tag
  assert.ok(wf.includes('NEXT="v${MAJOR}.'), "scope must build NEXT from MAJOR");
  assert.ok(wf.includes('echo "moving=$MOVING"'), "scope must emit the moving tag it computed");
  // the tagging step advances that computed tag, not a literal
  assert.ok(wf.includes("MOVING: ${{ steps.scope.outputs.moving }}"),
    "the tagging step must take the moving tag from the scope step");
  assert.ok(wf.includes('git tag -f "$MOVING" "$NEXT"'),
    "the tag-advance must anchor the moving tag at the new release");
  assert.ok(wf.includes('git push -q -f origin "$MOVING"'),
    "the tag-advance must push the moving tag");
  // the defect itself: advancing a literal tag the docs do not pin
  assert.doesNotMatch(wf, /git tag -f v(?:\s|"|$)/,
    "bare-'v' advance must not come back — it is not the documented pin");
  assert.doesNotMatch(wf, /origin v(?:\s|$)/,
    "pushing bare 'v' must not come back — it is not the documented pin");
});

test("the workflow's release scope targets the major the docs pin", () => {
  const wf = read(".github", "workflows", "drift-check.yml");
  const glob = wf.match(/git tag -l '(v\d+)\.\*'/);
  assert.ok(glob, "scope must list release tags with a 'v<major>.*' glob");
  const major = readmePin().match(/^v(\d+)$/)?.[1];
  assert.ok(major, "the documented pin must be a major-only moving tag");
  assert.equal(glob[1], `v${major}`,
    "the release glob's major must match the documented pin — bumping the major means moving docs, examples and drift-check together");
});
