import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url);
const base = await readFile(new URL("i18n/en.ts", root), "utf8");
if (!base.includes("Record<keyof typeof ru, string>"))
  throw new Error("RU/EN base catalogs are not statically key-synchronized");
const index = await readFile(new URL("i18n/index.ts", root), "utf8");
if (!index.includes("const pseudo ="))
  throw new Error("Pseudo-locale is required");
if (!index.includes("document.documentElement.lang"))
  throw new Error("HTML lang must follow locale");

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Settings and agents keep their historical inline copy; the redesigned
      // messenger modules must stay catalog-only.
      if (["node_modules", "settings", "agents"].includes(entry.name)) continue;
      yield* walk(path);
    } else yield path;
  }
}
for await (const path of walk(root.pathname)) {
  if (!/\.(ts|tsx)$/.test(path) || /\.test\.tsx?$/.test(path)) continue;
  const content = await readFile(path, "utf8");
  if (/\/i18n\.ts$/.test(path)) {
    if (!content.includes("defineCatalog("))
      throw new Error(`${path} must declare its keys through defineCatalog()`);
    continue;
  }
  if (/\/i18n\/(ru|en|index|catalog)\.ts$/.test(path)) continue;
  if (/[А-Яа-яЁё]/.test(content))
    throw new Error(`${path} contains Cyrillic outside the locale catalogs`);
}
