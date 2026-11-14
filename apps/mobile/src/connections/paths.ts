/** Screens of Settings → Workspace → Models / Integrations; others link here. */
export const connectionsPaths = {
  models: "/settings/connections/models",
  newModel: "/settings/connections/models/new",
  model: (id: string) =>
    `/settings/connections/models/${encodeURIComponent(id)}` as const,
  integrations: "/settings/connections/integrations",
  newMcp: "/settings/connections/integrations/mcp/new",
  mcp: (id: string) =>
    `/settings/connections/integrations/mcp/${encodeURIComponent(id)}` as const,
  newWebhook: "/settings/connections/integrations/webhooks/new",
  webhook: (id: string) =>
    `/settings/connections/integrations/webhooks/${encodeURIComponent(id)}` as const,
};
