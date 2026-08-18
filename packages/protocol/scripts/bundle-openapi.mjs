import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const openAPIPath = path.join(packageRoot, "openapi.yaml");
const realtimeSchemaPath = path.join(
  packageRoot,
  "schemas/realtime/v1.schema.json",
);
const outputPath = path.join(packageRoot, "src/generated/openapi.bundle.json");
const realtimeReference = "./schemas/realtime/v1.schema.json#/$defs/";

const openAPI = yaml.load(await readFile(openAPIPath, "utf8"));
const realtimeSchema = JSON.parse(await readFile(realtimeSchemaPath, "utf8"));

function realtimeDefinition(name, stack = []) {
  if (stack.includes(name)) {
    throw new Error(
      `recursive realtime schema reference: ${[...stack, name].join(" -> ")}`,
    );
  }
  const definition = realtimeSchema.$defs?.[name];
  if (!definition)
    throw new Error(`unknown realtime schema definition: ${name}`);
  return resolveRealtimeReferences(structuredClone(definition), [
    ...stack,
    name,
  ]);
}

function resolveRealtimeReferences(value, stack = []) {
  if (Array.isArray(value))
    return value.map((item) => resolveRealtimeReferences(item, stack));
  if (value === null || typeof value !== "object") return value;

  if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
    const name = value.$ref.slice("#/$defs/".length);
    const resolved = realtimeDefinition(name, stack);
    const siblings = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "$ref"),
    );
    return resolveRealtimeReferences({ ...resolved, ...siblings }, stack);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveRealtimeReferences(item, stack),
    ]),
  );
}

function bundleExternalReferences(value) {
  if (Array.isArray(value)) return value.map(bundleExternalReferences);
  if (value === null || typeof value !== "object") return value;

  if (
    typeof value.$ref === "string" &&
    value.$ref.startsWith(realtimeReference)
  ) {
    const name = value.$ref.slice(realtimeReference.length);
    const resolved = realtimeDefinition(name);
    const siblings = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "$ref"),
    );
    return bundleExternalReferences({ ...resolved, ...siblings });
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      bundleExternalReferences(item),
    ]),
  );
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(bundleExternalReferences(openAPI), null, 2)}\n`,
);
