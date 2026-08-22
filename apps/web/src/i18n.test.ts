import { describe, expect, it } from "vitest";

import i18n from "./i18n";

describe("translations", () => {
  it.each([
    ["ru", "Шаг 2 из 5"],
    ["en", "Step 2 of 5"],
  ])("interpolates ICU placeholders for %s", (locale, expected) => {
    const translate = i18n.getFixedT(locale);
    expect(translate("agentWizardStep", { current: 2, total: 5 })).toBe(
      expected,
    );
  });

  it.each(["ru", "en", "pseudo"])(
    "does not contain legacy double-brace placeholders in %s",
    (locale) => {
      const bundle = i18n.getResourceBundle(locale, "translation") as Record<
        string,
        string
      >;
      expect(
        Object.values(bundle).filter((value) => value.includes("{{")),
      ).toEqual([]);
    },
  );
});
