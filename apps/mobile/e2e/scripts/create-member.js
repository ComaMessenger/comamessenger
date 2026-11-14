// Adds a fresh workspace member through an invitation, so settings flows can
// change roles, statuses and passwords without touching the seeded people.
// Run scripts/login.js first (as the owner). Outputs memberEmail,
// memberPassword, memberName, memberTag, memberID.
var tag = String(Date.now()).slice(-7);
var auth = { Authorization: output.auth, "Content-Type": "application/json" };
var invitation = json(
  http.post(output.api + "/api/v1/invitations", {
    headers: auth,
    body: JSON.stringify({
      email: "e2e-" + tag + "@example.test",
      role: "member",
    }),
  }).body,
);
var token = invitation.accept_url.split("/").pop();
output.memberEmail = "e2e-" + tag + "@example.test";
output.memberPassword = "e2e-password-" + tag;
output.memberName = "E2E " + tag;
output.memberTag = tag;
var accepted = http.post(
  output.api + "/api/v1/invitations/" + token + "/accept",
  {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: output.memberName,
      handle: "e2e" + tag,
      password: output.memberPassword,
    }),
  },
);
output.memberID = json(accepted.body).user.id;
