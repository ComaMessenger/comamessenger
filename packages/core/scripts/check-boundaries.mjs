import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const root = new URL("../src/", import.meta.url);
for (const name of await readdir(root)) {
  if (!name.endsWith(".ts")) continue;
  const source = await readFile(join(root.pathname, name), "utf8");
  if (/from ["'](?:react|react-dom|@tanstack\/react)/.test(source)) throw new Error(`Platform boundary violation in ${name}: packages/core must not import React or the DOM.`);
}
