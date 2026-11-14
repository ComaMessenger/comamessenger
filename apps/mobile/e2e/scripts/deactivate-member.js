// Deactivates the member create-member.js added, so test accounts do not
// stay active in the shared workspace.
http.request(output.api + "/api/v1/organization/members/" + output.memberID, {
  method: "PATCH",
  headers: { Authorization: output.auth, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "deactivated" }),
});
