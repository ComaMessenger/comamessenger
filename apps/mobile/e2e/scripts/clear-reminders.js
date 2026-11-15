// Removes every reminder of the test account, so reminder.yaml starts from
// an empty «Напоминания» whatever earlier runs left. Run scripts/login.js first.
var auth = { Authorization: output.auth };
var states = ["pending", "fired"];
for (var s = 0; s < states.length; s++) {
  var items = json(
    http.get(output.api + "/api/v1/reminders?limit=100&state=" + states[s], {
      headers: auth,
    }).body,
  ).items;
  for (var i = 0; i < items.length; i++)
    http.request(output.api + "/api/v1/reminders/" + items[i].id, {
      method: "DELETE",
      headers: auth,
    });
}
