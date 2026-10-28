import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const theme = readFileSync(path.join(__dirname, "theme.css"), "utf8");
const legacy = readFileSync(path.join(__dirname, "legacy-colors.css"), "utf8");
const palette = readFileSync(path.resolve("node_modules/tailwindcss/theme.css"), "utf8");
const primitives = new Set([...palette.matchAll(/--(color-[\w-]+):\s*oklch/g)].map((m) => m[1]));
const fallbacks = new Map([...legacy.matchAll(/--(color-[\w-]+):\s*(rgb\([^;]+\));/g)].map((m) => [m[1], m[2]]));

describe("system WebKit colour fallbacks", () => {
  it("covers each OKLCH primitive consumed by the semantic theme", () => {
    const referenced = [...theme.matchAll(/var\(--(color-[\w-]+)/g)].map((m) => m[1]);
    expect([...new Set(referenced.filter((name) => primitives.has(name) && !fallbacks.has(name)))]).toEqual([]);
    // Reproduced natively: neutral-800 remained OKLCH and separator-border
    // fell back to white text. The legacy dark separator must be graphite.
    expect(fallbacks.get("color-neutral-800")).toBe("rgb(38 38 38)");
  });

  it("covers dark semantic mixes and leaves modern colours behind feature guards", () => {
    const mixes = [...theme.matchAll(/--(color-[\w-]+):\s*color-mix\([^;]+;/g)].map((m) => m[1]);
    expect(mixes.filter((name) => !fallbacks.has(name))).toEqual([]);
    expect(legacy).toContain("@supports not (color: oklch(0.5 0 0))");
    expect(legacy).toContain("@supports not (color: color-mix(in srgb, white 50%, transparent))");
    expect(readFileSync(path.join(__dirname, "globals.css"), "utf8")).toContain('@import "./legacy-colors.css"');
  });
});
