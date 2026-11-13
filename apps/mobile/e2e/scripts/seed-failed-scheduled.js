// An unsent scheduled message with a reason, made the way it happens: a
// message is scheduled in a new group, the group is archived, and «Send now»
// leaves the record failed (chat_unavailable). Run scripts/login.js first.
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
var headers = {
  Authorization: output.auth,
  "Content-Type": "application/json",
};
var tag = String(Date.now()).slice(-6);
var chat = json(
  http.post(output.api + "/api/v1/chats", {
    headers: headers,
    body: JSON.stringify({ kind: "group", name: "Архив " + tag }),
  }).body,
);
var record = json(
  http.post(output.api + "/api/v1/chats/" + chat.id + "/scheduled-messages", {
    headers: headers,
    body: JSON.stringify({
      client_msg_id: uuid(),
      body: "Неотправленное " + tag,
      body_format: "plain",
      send_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    }),
  }).body,
);
http.request(output.api + "/api/v1/chats/" + chat.id, {
  method: "DELETE",
  headers: headers,
});
http.post(output.api + "/api/v1/scheduled-messages/" + record.id + "/send", {
  headers: headers,
  body: "{}",
});
output.failedTag = tag;
