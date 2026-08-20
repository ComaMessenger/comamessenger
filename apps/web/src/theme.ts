export function setTheme(value: string): void {
  localStorage.setItem("coma-theme", value);
  const resolved =
    value === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : value;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#181a1f" : "#f3f6fa");
}
