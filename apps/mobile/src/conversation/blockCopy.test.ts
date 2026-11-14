import { describe, expect, it } from "vitest";
import { ru } from "../i18n/ru";
import { en } from "../i18n/en";
import { confirmationKey, fieldLabels, toolPhrases } from "./blockCopy";

describe("confirmation card copy", () => {
  it("has Russian and English text for every server tool, field and status", () => {
    const keys = [
      ...Object.values(toolPhrases),
      ...Object.values(fieldLabels),
      ...Object.values(confirmationKey),
      "acToolGeneric",
      "acConfirmApprove",
      "acConfirmDeny",
    ];
    for (const key of keys) {
      expect(ru).toHaveProperty(key);
      expect(en).toHaveProperty(key);
    }
    expect(toolPhrases.send_direct_message).toBe("acToolSendDirect");
  });
});
