// The owner asks the fresh member for a new password (create-member.js first).
http.post(
  output.api +
    "/api/v1/organization/members/" +
    output.memberID +
    "/require-password-change",
  { headers: { Authorization: output.auth }, body: "" },
);
