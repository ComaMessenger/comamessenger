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
  "typing-action": "RealtimeTypingEventFrameV1",
  presence: "RealtimePresenceEventFrameV1",
  "presence-snapshot": "RealtimePresenceSnapshotFrameV1",
  "event-message-request": "RealtimeDurableEventFrameV1",
  "event-request-assigned": "RealtimeDurableEventFrameV1",
  "event-request-updated": "RealtimeDurableEventFrameV1",
  "event-request-tally-updated": "RealtimeDurableEventFrameV1",
  "event-request-answer-updated": "RealtimeDurableEventFrameV1",
  "event-request-reminded": "RealtimeDurableEventFrameV1",
  "event-request-auto-reminded": "RealtimeDurableEventFrameV1",
  "event-reminder-created": "RealtimeDurableEventFrameV1",
  "event-reminder-updated": "RealtimeDurableEventFrameV1",
  "event-reminder-deleted": "RealtimeDurableEventFrameV1",
  "event-reminder-fired": "RealtimeDurableEventFrameV1",
  "event-message-department-mention": "RealtimeDurableEventFrameV1",
  "event-message-request-position": "RealtimeDurableEventFrameV1",
  "event-org-updated": "RealtimeDurableEventFrameV1",
  "event-message-task": "RealtimeDurableEventFrameV1",
  "event-task-updated": "RealtimeDurableEventFrameV1",
  "event-task-notified": "RealtimeDurableEventFrameV1",
};
// Typed data of durable events: the fixture's data must also satisfy it.
const dataSchemaByEventType = {
  "message.created": "Message",
  "request.assigned": "RealtimeRequestAssignedEventV1",
  "request.updated": "RealtimeRequestUpdatedEventV1",
  "request.tally.updated": "RealtimeRequestTallyUpdatedEventV1",
  "request.answer.updated": "RealtimeRequestAnswerUpdatedEventV1",
  "request.reminded": "RealtimeRequestRemindedEventV1",
  "request.auto_reminded": "RealtimeRequestAutoRemindedEventV1",
  "reminder.created": "RealtimeReminderEventV1",
  "reminder.updated": "RealtimeReminderEventV1",
  "reminder.deleted": "RealtimeReminderEventV1",
  "reminder.fired": "RealtimeReminderFiredEventV1",
  "org.updated": "RealtimeOrgUpdatedEventV1",
  "task.updated": "TaskUpdatedEvent",
  "task.notified": "RealtimeTaskNotifiedEventV1",
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
  // event.json keeps free-form data; the typed event fixtures check it too.
  const dataSchema =
    name.startsWith("event-") && dataSchemaByEventType[fixture.type];
  if (name.startsWith("event-") && !dataSchema)
    throw new Error(`fixture ${file} has no data schema for ${fixture.type}`);
  const target = dataSchema
    ? `Schemas[${JSON.stringify(schema)}] & { data: Schemas[${JSON.stringify(dataSchema)}] }`
    : `Schemas[${JSON.stringify(schema)}]`;
  entries.push(
    `  ${JSON.stringify(name)}: ${JSON.stringify(fixture, null, 2).replaceAll("\n", "\n  ")} as const satisfies ${target},`,
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
