import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDuration,
  toolLabel,
  type Translate,
} from "./agentText";

const t = ((key: string, values?: Record<string, unknown>) =>
  key === "agentTool_post_message"
    ? "Отправить сообщение"
    : values
      ? `${key}:${JSON.stringify(values)}`
      : key) as Translate;

describe("agent formatting", () => {
  it("formats durations through the catalog", () => {
    expect(formatDuration(t, 4.2)).toBe('agentDurationSeconds:{"count":4}');
    expect(formatDuration(t, 600)).toBe('agentDurationMinutes:{"count":10}');
    expect(formatDuration(t, 0)).toBe("—");
  });

  it("uses the reported currency", () => {
    expect(formatCost("1.5", "EUR", "en")).toBe("€1.50");
    expect(formatCost("0.0042", "USD", "en")).toBe("$0.0042");
    expect(formatCost("2", "RUB", "ru")).toContain("₽");
  });

  it("names unknown tools in words", () => {
    expect(toolLabel(t, "post_message")).toBe("Отправить сообщение");
    expect(toolLabel(t, "get_slots-today")).toBe(
      'agentToolExternal:{"name":"get slots today"}',
    );
  });
});
