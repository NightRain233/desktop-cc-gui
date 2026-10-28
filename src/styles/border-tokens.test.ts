import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tailwind v4 silently emits nothing for a colour utility whose theme token
 * does not exist, and a bare `border` then falls back to `currentColor` — the
 * near-black outline the grant / question / plan cards shipped with while
 * they referenced a non-existent `border-border-secondary`. Guard the two
 * border palettes (`border-border-*`, `border-separator-*`) against typos.
 */
const SRC = path.resolve(__dirname, "..");
const themeCss = readFileSync(path.join(SRC, "styles/theme.css"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("border colour utilities", () => {
  it("every border-border-* / border-separator-* class maps to a theme token", () => {
    const missing = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      // Optional variant prefixes (hover:, focus-visible:, …) and an opacity
      // suffix (/40) are not part of the token name.
      for (const match of text.matchAll(/\bborder-((?:border|separator)-[a-z0-9-]+)/g)) {
        const token = match[1];
        if (!new RegExp(`--color-${token}\\s*:`).test(themeCss)) {
          missing.add(`${token} (${path.relative(SRC, file)})`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
