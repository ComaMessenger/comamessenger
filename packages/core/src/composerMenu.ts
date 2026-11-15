import { hasServerFeature, serverFeature } from "./realtime";

/**
 * Items of the composer's «+» menu, shared by the phone and the web so both
 * keep the same order and rules (variant A of the prototype):
 *
 * 1. attachments — photo, camera, file on the phone; «Фото и видео», «Файл»,
 *    «Markdown-файл» on the web, which has no camera;
 * 2. «Попросить и поручить» — «Запрос» (wave 1), «Задача» (wave 3) after
 *    it, each only when the server announced its feature; «Опрос» (wave 4)
 *    will take the place between them;
 * 3. «Агенты» — «Позвать агента» when the chat has agents.
 *
 * Scheduling is not here: it stays on a long press of «Отправить».
 */

export type ComposerMenuItemID =
  | "photo"
  | "camera"
  | "file"
  | "markdownFile"
  | "request"
  | "task"
  | "agent";

export type ComposerMenuGroupID = "attachments" | "ask" | "agents";

export type ComposerMenuItem = {
  id: ComposerMenuItemID;
  /** Translation key of the title. */
  labelKey: string;
  /** Translation key of the hint under the title; group rows only. */
  hintKey: string | null;
};

export type ComposerMenuGroup = {
  id: ComposerMenuGroupID;
  /** Translation key of the group caption; attachments have none. */
  labelKey: string | null;
  items: ComposerMenuItem[];
};

export type ComposerMenuFacts = {
  platform: "mobile" | "web";
  /** The reader cannot post here (a channel for readers, an archived chat). */
  readonly: boolean;
  /** The chat has agents to call. */
  hasAgents: boolean;
  /** HelloFrame.features of the connection; nothing new before hello. */
  features: Iterable<string> | null | undefined;
  /**
   * The composer of a thread: requests and tasks go to the chat's feed
   * only, so neither is offered there.
   */
  inThread?: boolean;
};

const item = (
  id: ComposerMenuItemID,
  labelKey: string,
  hintKey: string | null = null,
): ComposerMenuItem => ({ id, labelKey, hintKey });

const attachments: Record<ComposerMenuFacts["platform"], ComposerMenuItem[]> = {
  mobile: [
    item("photo", "composerPhoto"),
    item("camera", "composerCamera"),
    item("file", "composerFile"),
  ],
  web: [
    item("photo", "composerPhotoVideo"),
    item("file", "composerFile"),
    item("markdownFile", "composerMarkdownFile"),
  ],
};

/**
 * The groups of the «+» menu, in the prototype's order, without empty
 * groups. The «Попросить и поручить» caption stays even with one item, so the
 * menu does not move when «Опрос» and «Задача» arrive.
 */
export function composerMenu(facts: ComposerMenuFacts): ComposerMenuGroup[] {
  if (facts.readonly) return [];
  const ask: ComposerMenuItem[] = [];
  if (
    !facts.inThread &&
    hasServerFeature(facts.features, serverFeature.requests)
  )
    ask.push(item("request", "composerRequest", "composerRequestHint"));
  if (!facts.inThread && hasServerFeature(facts.features, serverFeature.tasks))
    ask.push(item("task", "composerTask", "composerTaskHint"));
  const groups: ComposerMenuGroup[] = [
    {
      id: "attachments",
      labelKey: null,
      items: attachments[facts.platform].map((entry) => ({ ...entry })),
    },
    { id: "ask", labelKey: "composerAskGroup", items: ask },
    {
      id: "agents",
      labelKey: "composerAgentsGroup",
      items: facts.hasAgents
        ? [item("agent", "composerCallAgent", "composerCallAgentHint")]
        : [],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** The menu as a flat list of item ids, for tests and keyboard order. */
export function composerMenuItems(
  facts: ComposerMenuFacts,
): ComposerMenuItemID[] {
  return composerMenu(facts).flatMap((group) =>
    group.items.map((entry) => entry.id),
  );
}
