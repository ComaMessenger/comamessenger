// Turns back on the model connections disable-models.js turned off.
var auth = { Authorization: output.auth, "Content-Type": "application/json" };
var ids = (output.disabledModels || "").split(",");
for (var i = 0; i < ids.length; i++)
  if (ids[i])
    http.patch(output.api + "/api/v1/agent-connections/" + ids[i], {
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
