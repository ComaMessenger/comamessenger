// Launch settings of sign-in.yaml and open-app.yaml. Maestro 2.x lets a
// flow's own env: block win over `-e` on the command line, so the defaults
// live here and every value can still be overridden:
//   maestro test -e SERVER=10.0.2.2:8380 -e DEV_CLIENT=true e2e/sign-in.yaml
function given(value, fallback) {
  return typeof value !== "undefined" && value !== ""
    ? String(value)
    : fallback;
}
output.launch = {
  server: given(
    typeof SERVER !== "undefined" ? SERVER : undefined,
    "localhost:8080",
  ),
  email: given(
    typeof EMAIL !== "undefined" ? EMAIL : undefined,
    "lev@example.test",
  ),
  password: given(
    typeof PASSWORD !== "undefined" ? PASSWORD : undefined,
    "coma-mobile-dev-1",
  ),
  metro: given(
    typeof METRO !== "undefined" ? METRO : undefined,
    "http%3A%2F%2Flocalhost%3A8081",
  ),
  dev:
    given(
      typeof DEV_CLIENT !== "undefined" ? DEV_CLIENT : undefined,
      "false",
    ) === "true",
};
