// Answers the test account's latest request in «Планёрка · запросы» as Анна
// Иванова (made by seed-requests.mjs): the first button with a comment.
// Run scripts/login.js first (it sets output.api).
var login = json(
  http.post(output.api + "/api/v1/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "anna.requests@example.test",
      password: "coma-requests-anna-1",
    }),
  }).body,
);
var auth = {
  Authorization: "Bearer " + login.access_token,
  "Content-Type": "application/json",
};
var chats = json(
  http.get(output.api + "/api/v1/chats", { headers: auth }).body,
).chats;
var chat = null;
for (var i = 0; i < chats.length; i++)
  if (chats[i].name === "Планёрка · запросы") chat = chats[i];
var messages = json(
  http.get(output.api + "/api/v1/chats/" + chat.id + "/messages?limit=30", {
    headers: auth,
  }).body,
).messages;
var target = null;
for (var j = 0; j < messages.length; j++) {
  var message = messages[j];
  if (
    message.type === "request" &&
    message.actor_id !== login.user.id &&
    (!target || message.created_seq > target.created_seq)
  )
    target = message;
}
var answered = http.put(
  output.api + "/api/v1/requests/" + target.id + "/answer",
  {
    headers: auth,
    body: JSON.stringify({ option: 0, comment: "захвачу перчатки" }),
  },
);
output.answerStatus = answered.status;
