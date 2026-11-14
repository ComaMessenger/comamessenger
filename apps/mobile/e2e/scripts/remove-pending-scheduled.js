// Deletes the message seed-pending-scheduled.js scheduled.
http.request(
  output.api + "/api/v1/scheduled-messages/" + output.pendingScheduledID,
  { method: "DELETE", headers: { Authorization: output.auth } },
);
