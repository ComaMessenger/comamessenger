// One waiting scheduled message in the account's first chat, so the security
// screens show their «will not be sent» warning. Run scripts/login.js first;
// scripts/remove-pending-scheduled.js deletes it.
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
var chat = json(
  http.get(output.api + "/api/v1/chats", { headers: headers }).body,
).chats[0];
output.pendingScheduledID = json(
  http.post(output.api + "/api/v1/chats/" + chat.id + "/scheduled-messages", {
    headers: headers,
    body: JSON.stringify({
      client_msg_id: uuid(),
      body: "Проверка предупреждения настроек",
      body_format: "plain",
      send_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    }),
  }).body,
).id;
