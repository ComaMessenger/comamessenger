// Starts settings.yaml from a known state: no notification schedule or pause,
// and the theme following the device (so the simulator's appearance picks
// light or dark). The account's own theme is kept in output.originalTheme
// for scripts/restore-preferences.js. Run scripts/login.js first.
var headers = {
  Authorization: output.auth,
  "Content-Type": "application/json",
};
output.originalTheme = json(
  http.get(output.api + "/api/v1/preferences", { headers: headers }).body,
).theme;
http.request(output.api + "/api/v1/preferences", {
  method: "PATCH",
  headers: headers,
  body: JSON.stringify({
    schedule: null,
    snoozed_until: null,
    theme: "system",
  }),
});
