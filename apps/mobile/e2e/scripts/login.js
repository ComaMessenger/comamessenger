// Shared by the runScript helpers: signs the test account in through the API.
// env SERVER, EMAIL, PASSWORD (defaults: sign-in.yaml).
var api =
  "http://" + (typeof SERVER !== "undefined" ? SERVER : "localhost:8080");
var login = http.post(api + "/api/v1/auth/login", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: typeof EMAIL !== "undefined" ? EMAIL : "lev@example.test",
    password: typeof PASSWORD !== "undefined" ? PASSWORD : "coma-mobile-dev-1",
  }),
});
output.api = api;
output.auth = "Bearer " + json(login.body).access_token;
