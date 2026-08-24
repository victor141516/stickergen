import { readFileSync } from "node:fs";

const stylePresets = JSON.parse(
  readFileSync(new URL("./styles.json", import.meta.url), "utf8"),
);

for (const preset of stylePresets) {
  for (const field of ["id", "name", "buttonText", "description", "prompt"]) {
    if (typeof preset[field] !== "string" || !preset[field].trim()) {
      throw new Error(`Invalid style preset field: ${field}`);
    }
  }
  if (!/^[a-z0-9-]+$/.test(preset.id)) {
    throw new Error(`Invalid style preset id: ${preset.id}`);
  }
}

const presetsById = new Map(stylePresets.map((preset) => [preset.id, preset]));
if (presetsById.size !== stylePresets.length) {
  throw new Error("Style preset ids must be unique");
}

export function listStylePresets() {
  return stylePresets;
}

export function getStylePreset(id) {
  return presetsById.get(id) || null;
}

export function promptWithStylePreset(userPrompt, preset) {
  if (!preset) return userPrompt;
  return [
    "USER REQUEST — highest priority:",
    userPrompt,
    "",
    `OPTIONAL STYLE PRESET — ${preset.name}:`,
    preset.prompt,
    "",
    "Apply the preset only where it does not conflict with the user request. If the user request names, describes, or implies a different visual style, follow the user's style and ignore the preset.",
  ].join("\n");
}
