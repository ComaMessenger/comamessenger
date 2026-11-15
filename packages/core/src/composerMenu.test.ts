import { describe, expect, it } from "vitest";
import { composerMenu, composerMenuItems } from "./composerMenu";

const features = ["typing_actions", "message_requests", "message_reminders"];

describe("composerMenu", () => {
  it("follows variant A on the phone: attachments, ask, agents", () => {
    const groups = composerMenu({
      platform: "mobile",
      readonly: false,
      hasAgents: true,
      features,
    });
    expect(groups.map((group) => [group.id, group.labelKey])).toEqual([
      ["attachments", null],
      ["ask", "composerAskGroup"],
      ["agents", "composerAgentsGroup"],
    ]);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.id)),
    ).toEqual(["photo", "camera", "file", "request", "agent"]);
    expect(groups[1]!.items[0]).toEqual({
      id: "request",
      labelKey: "composerRequest",
      hintKey: "composerRequestHint",
    });
  });

  it("has no camera on the web but a Markdown file", () => {
    expect(
      composerMenuItems({
        platform: "web",
        readonly: false,
        hasAgents: false,
        features,
      }),
    ).toEqual(["photo", "file", "markdownFile", "request"]);
  });

  it("has no scheduling, poll or task", () => {
    const ids: string[] = composerMenuItems({
      platform: "mobile",
      readonly: false,
      hasAgents: true,
      features,
    });
    for (const absent of ["schedule", "later", "poll", "task", "checklist"])
      expect(ids).not.toContain(absent);
  });

  it("hides «Запрос» until the server announces requests", () => {
    for (const value of [undefined, null, [], ["message_reminders"]])
      expect(
        composerMenuItems({
          platform: "mobile",
          readonly: false,
          hasAgents: false,
          features: value,
        }),
      ).toEqual(["photo", "camera", "file"]);
  });

  it("hides «Запрос» in a thread and everything in a read-only chat", () => {
    expect(
      composerMenuItems({
        platform: "mobile",
        readonly: false,
        hasAgents: true,
        features,
        inThread: true,
      }),
    ).toEqual(["photo", "camera", "file", "agent"]);
    expect(
      composerMenu({
        platform: "mobile",
        readonly: true,
        hasAgents: true,
        features,
      }),
    ).toEqual([]);
  });

  it("accepts the features as a set", () => {
    expect(
      composerMenuItems({
        platform: "web",
        readonly: false,
        hasAgents: false,
        features: new Set(features),
      }),
    ).toContain("request");
  });
});

describe("composerMenu: «Задача» (wave 3)", () => {
  const withTasks = [...features, "message_tasks"];
  it("follows «Запрос» in «Попросить и поручить» with its hint", () => {
    const groups = composerMenu({
      platform: "mobile",
      readonly: false,
      hasAgents: false,
      features: withTasks,
    });
    expect(groups[1]!.items).toEqual([
      {
        id: "request",
        labelKey: "composerRequest",
        hintKey: "composerRequestHint",
      },
      { id: "task", labelKey: "composerTask", hintKey: "composerTaskHint" },
    ]);
  });

  it("comes only with message_tasks, also without requests", () => {
    expect(
      composerMenuItems({
        platform: "web",
        readonly: false,
        hasAgents: false,
        features: ["message_tasks"],
      }),
    ).toEqual(["photo", "file", "markdownFile", "task"]);
    expect(
      composerMenuItems({
        platform: "web",
        readonly: false,
        hasAgents: false,
        features,
      }),
    ).not.toContain("task");
  });

  it("is not offered in a thread or a read-only chat", () => {
    expect(
      composerMenuItems({
        platform: "mobile",
        readonly: false,
        hasAgents: false,
        features: withTasks,
        inThread: true,
      }),
    ).toEqual(["photo", "camera", "file"]);
    expect(
      composerMenuItems({
        platform: "mobile",
        readonly: true,
        hasAgents: false,
        features: withTasks,
      }),
    ).toEqual([]);
  });
});
