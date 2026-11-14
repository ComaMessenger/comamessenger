// Turns off every enabled model connection, so the builder shows «Подключить
// модель». Remembers them in output.disabledModels for enable-models.js,
// which agent-links.yaml runs right after. Run after login.js.
var auth = { Authorization: output.auth, "Content-Type": "application/json" };
var items = json(
  http.get(output.api + "/api/v1/agent-connections", { headers: auth }).body,
);
var disabled = [];
for (var i = 0; i < items.length; i++)
  if (items[i].enabled) {
    http.request(output.api + "/api/v1/agent-connections/" + items[i].id, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    });
    disabled.push(items[i].id);
  }
output.disabledModels = disabled.join(",");
