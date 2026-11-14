// Removes agents earlier runs of the builder flows created (named «E2E …»),
// so every run starts from the same catalog. Run scripts/login.js first.
var auth = { Authorization: output.auth };
var agents = json(
  http.get(output.api + "/api/v1/agents", { headers: auth }).body,
);
for (var i = 0; i < agents.length; i++) {
  if (agents[i].display_name.indexOf("E2E ") === 0)
    http.delete(output.api + "/api/v1/agents/" + agents[i].id, {
      headers: auth,
    });
}
