// Saves the latest message of two chats to «Important», so the tab has
// chat filters to show (they appear with saves from two chats or more).
// Saving is idempotent. Run scripts/login.js first.
var auth = { Authorization: output.auth };
var chats = json(
  http.get(output.api + "/api/v1/chats", { headers: auth }).body,
).chats;
var saved = 0;
for (var i = 0; i < chats.length && saved < 2; i++) {
  var page = json(
    http.get(
      output.api + "/api/v1/chats/" + chats[i].id + "/messages?limit=5",
      {
        headers: auth,
      },
    ).body,
  );
  var messages = page.messages || [];
  for (var j = 0; j < messages.length; j++) {
    if (messages[j].deleted_at) continue;
    http.put(output.api + "/api/v1/messages/" + messages[j].id + "/saved", {
      headers: auth,
      body: "",
    });
    saved += 1;
    break;
  }
}
