import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureRoot = path.join(packageRoot, "fixtures/realtime/v1");
const outputPath = path.join(packageRoot, "src/generated/realtime-fixtures.ts");
const schemaByFixture = {
  ack: "RealtimeAckFrameV1",
  auth: "RealtimeAuthFrameV1",
  event: "RealtimeDurableEventFrameV1",
  hello: "RealtimeHelloFrameV1",
  "resync-required": "RealtimeResyncRequiredFrameV1",
  typing: "RealtimeTypingEventFrameV1",
};

const files = (await readdir(fixtureRoot))
  .filter((file) => file.endsWith(".json"))
  .sort();
const entries = [];
for (const file of files) {
  const name = path.basename(file, ".json");
  const schema = schemaByFixture[name];
  if (!schema)
    throw new Error(`fixture ${file} has no generated schema mapping`);
  const fixture = JSON.parse(
    await readFile(path.join(fixtureRoot, file), "utf8"),
  );
  entries.push(
    `  ${JSON.stringify(name)}: ${JSON.stringify(fixture, null, 2).replaceAll("\n", "\n  ")} as const satisfies Schemas[${JSON.stringify(schema)}],`,
  );
}

const source = `/**
 * This file was auto-generated from fixtures/realtime/v1.
 * Do not make direct changes to the file.
 */

import type { components } from "./schema.js";

type Schemas = components["schemas"];

export const realtimeV1Fixtures = {
${entries.join("\n")}
};
`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, source);
