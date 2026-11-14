// Removes what connections.yaml creates (by name), so the flow can run again.
// Leaves every other connection alone. Run after login.js.
var auth = { Authorization: output.auth };
var lists = [
  ["/api/v1/agent-connections", "Provod e2e"],
  ["/api/v1/integrations/mcp-connections", "deepwiki-e2e"],
  ["/api/v1/integrations/webhooks", "Склад e2e"],
];
for (var i = 0; i < lists.length; i++) {
  var items = json(http.get(output.api + lists[i][0], { headers: auth }).body);
  for (var j = 0; j < items.length; j++)
    if (items[j].name === lists[i][1])
      http.delete(output.api + lists[i][0] + "/" + items[j].id, {
        headers: auth,
      });
}
