// Votes in the test account's latest poll in «Опросы · планёрка» as Анна Иванова
// (the first option) and Олег Чернов (the second), both made by
// seed-polls.mjs. Run scripts/login.js first (it sets output.api and
// output.auth).
function signIn(email, password) {
  return json(
    http.post(output.api + "/api/v1/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password }),
    }).body,
  );
}
var me = json(
  http.get(output.api + "/api/v1/me", {
    headers: { Authorization: output.auth },
  }).body,
);
var chats = json(
  http.get(output.api + "/api/v1/chats", {
    headers: { Authorization: output.auth },
  }).body,
).chats;
var chat = null;
for (var i = 0; i < chats.length; i++)
  if (chats[i].name === "Опросы · планёрка") chat = chats[i];
var messages = json(
  http.get(output.api + "/api/v1/chats/" + chat.id + "/messages?limit=30", {
    headers: { Authorization: output.auth },
  }).body,
).messages;
var target = null;
for (var j = 0; j < messages.length; j++) {
  var message = messages[j];
  if (
    message.type === "poll" &&
    !message.deleted_at &&
    message.actor_id === me.id &&
    (!target || message.created_seq > target.created_seq)
  )
    target = message;
}
var voters = [
  ["anna.polls@example.test", "coma-polls-anna-1", 0],
  ["oleg.polls@example.test", "coma-polls-oleg-1", 1],
];
output.voteStatus = [];
for (var k = 0; k < voters.length; k++) {
  var who = signIn(voters[k][0], voters[k][1]);
  var voted = http.put(output.api + "/api/v1/polls/" + target.id + "/vote", {
    headers: {
      Authorization: "Bearer " + who.access_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ options: [voters[k][2]] }),
  });
  output.voteStatus.push(voted.status);
}
