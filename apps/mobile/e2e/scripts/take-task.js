// Олег Чернов (seed-org.mjs) takes the newest open queue task of «Планёрка
// ЛФК», as the first candidate would. Run scripts/login.js first.
var headers = {
  Authorization: output.auth,
  "Content-Type": "application/json",
};
var chat = json(
  http.get(output.api + "/api/v1/chats", { headers: headers }).body,
).chats.filter(function (item) {
  return item.name === "Планёрка ЛФК";
})[0];
var tasks = json(
  http.get(output.api + "/api/v1/chats/" + chat.id + "/tasks?state=open", {
    headers: headers,
  }).body,
).items.filter(function (message) {
  return message.task.assignee.actor_id === null;
});
var oleg = json(
  http.post(output.api + "/api/v1/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "oleg.ch@example.test",
      password: "coma-org-e2e-1",
    }),
  }).body,
);
output.takeStatus = http.post(
  output.api + "/api/v1/tasks/" + tasks[0].id + "/take",
  // Maestro 2.x refuses a POST without a body.
  {
    headers: {
      Authorization: "Bearer " + oleg.access_token,
      "Content-Type": "application/json",
    },
    body: "{}",
  },
).status;
