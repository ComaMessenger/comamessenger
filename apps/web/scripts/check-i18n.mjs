import { readFile, readdir } from "node:fs/promises";
const source = await readFile(
  new URL("../src/i18n.ts", import.meta.url),
  "utf8",
);
if (!source.includes("Record<keyof typeof ru, string>"))
  throw new Error("RU/EN catalogs are not statically key-synchronized");
if (!source.includes("const pseudo ="))
  throw new Error("Pseudo-locale is required");
if (!source.includes("document.documentElement.lang"))
  throw new Error("HTML lang must follow locale");
const directory = new URL("../src/", import.meta.url);
for (const name of await readdir(directory)) {
  if (!/\.(ts|tsx)$/.test(name) || name === "i18n.ts") continue;
  const content = await readFile(new URL(name, directory), "utf8");
  if (/[А-Яа-яЁё]/.test(content))
    throw new Error(`${name} contains Cyrillic outside the locale catalog`);
}
