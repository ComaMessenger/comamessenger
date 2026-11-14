// The latest «Тред обхода <tag>: …» root in «Обход интерфейса», posted by
// seed-walkthrough.mjs right before the flow: output.walkthroughRoot is a
// pattern that matches only it. Run after login.js.
var auth = { Authorization: output.auth };
var chats = json(
  http.get(output.api + "/api/v1/chats", { headers: auth }).body,
).chats;
var chat = null;
for (var i = 0; i < chats.length; i++)
  if (chats[i].kind === "group" && chats[i].name === "Обход интерфейса")
    chat = chats[i];
if (!chat) throw new Error("Run seed-walkthrough.mjs first");
var messages = json(
  http.get(output.api + "/api/v1/chats/" + chat.id + "/messages?limit=20", {
    headers: auth,
  }).body,
).messages;
var tag = null;
for (var j = 0; j < messages.length; j++) {
  var match = /^Тред обхода (\d+):/.exec(messages[j].body || "");
  if (match && (!tag || messages[j].created_at > tag.at))
    tag = { value: match[1], at: messages[j].created_at };
}
if (!tag) throw new Error("No thread root: run seed-walkthrough.mjs first");
output.walkthroughRoot = ".*Тред обхода " + tag.value + ".*";
