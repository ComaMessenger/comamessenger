// Gives the account back the theme reset-preferences.js replaced.
http.request(output.api + "/api/v1/preferences", {
  method: "PATCH",
  headers: { Authorization: output.auth, "Content-Type": "application/json" },
  body: JSON.stringify({ theme: output.originalTheme }),
});
