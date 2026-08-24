import assert from "node:assert/strict";
import test from "node:test";
import { getStylePreset, listStylePresets, promptWithStylePreset } from "../src/styles.js";

test("loads six complete, uniquely addressable style presets from JSON", () => {
  const presets = listStylePresets();
  assert.equal(presets.length, 6);
  assert.equal(new Set(presets.map(({ id }) => id)).size, 6);
  for (const preset of presets) {
    assert.equal(getStylePreset(preset.id), preset);
    for (const field of ["id", "name", "buttonText", "description", "prompt"]) {
      assert.equal(typeof preset[field], "string");
      assert.ok(preset[field].length > 0);
    }
  }
});

test("places the user's prompt above the optional preset and makes it authoritative", () => {
  const preset = getStylePreset("1950s-newspaper");
  const prompt = promptWithStylePreset("A red robot in watercolor", preset);
  assert.ok(prompt.indexOf("A red robot in watercolor") < prompt.indexOf(preset.prompt));
  assert.match(prompt, /highest priority/i);
  assert.match(prompt, /follow the user's style and ignore the preset/i);
  assert.equal(promptWithStylePreset("plain prompt", null), "plain prompt");
});
