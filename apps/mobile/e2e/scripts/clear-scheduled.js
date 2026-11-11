// Deletes every scheduled message of the test account, so scheduled.yaml
// starts from an empty list whatever earlier runs left behind.
// Run scripts/login.js first.
var auth = { Authorization: output.auth };
var list = json(
  http.get(output.api + "/api/v1/scheduled-messages", { headers: auth }).body,
).scheduled_messages;
for (var i = 0; i < list.length; i++) {
  http.request(output.api + "/api/v1/scheduled-messages/" + list[i].id, {
    method: "DELETE",
    headers: auth,
  });
}
