// Runs the fictional accounting API and its MCP adapter for a local demo.
import { startAccountingAPI } from "./accounting-api.ts";
import { startAdapter } from "./server.ts";

const accountingToken =
  process.env.ACCOUNTING_API_TOKEN ?? "accounting-demo-token";
const mcpToken = process.env.MCP_TOKEN ?? "mcp-demo-token";
const accounting = await startAccountingAPI(
  accountingToken,
  Number(process.env.ACCOUNTING_PORT ?? 4010),
);
const adapter = await startAdapter({
  accountingURL: process.env.ACCOUNTING_API_URL ?? accounting.url,
  accountingToken,
  mcpToken,
  port: Number(process.env.MCP_PORT ?? 4020),
  host: process.env.MCP_HOST ?? "127.0.0.1",
});
console.log(`Accounting API: ${accounting.url}`);
console.log(`MCP adapter:    ${adapter.url}`);
console.log(
  `In Coma add an MCP connection to ${adapter.url} with header "Authorization: Bearer ${mcpToken}"`,
);
console.log(
  'and turn on "System in the internal network" (the adapter listens on 127.0.0.1).',
);
