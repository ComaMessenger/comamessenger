export type MarkdownNode =
  | { type: "text"; value: string }
  | {
      type: "strong" | "emphasis" | "underline" | "strike" | "code";
      children: MarkdownNode[];
    }
  | { type: "codeblock"; value: string }
  | { type: "link"; href: string; children: MarkdownNode[] }
  | { type: "mention"; actorID: string; label: string }
  | { type: "contextMention"; value: "all" | "here" }
  | { type: "heading"; level: 1 | 2 | 3; children: MarkdownNode[] }
  | { type: "list"; ordered: boolean; items: MarkdownNode[][] }
  | { type: "break" };
export function parseMarkdown(source: string): MarkdownNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: MarkdownNode[] = [];
  let fence: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (fence) {
        result.push({ type: "codeblock", value: fence.join("\n") });
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      if (result.length) result.push({ type: "break" });
      result.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!),
      });
      continue;
    }
    const listItem = /^(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (listItem) {
      const ordered = Boolean(listItem[2]);
      const previous = result.at(-1);
      const children = parseInline(listItem[3]!);
      if (previous?.type === "list" && previous.ordered === ordered)
        previous.items.push(children);
      else {
        if (result.length) result.push({ type: "break" });
        result.push({ type: "list", ordered, items: [children] });
      }
      continue;
    }
    if (result.length) result.push({ type: "break" });
    result.push(...parseInline(line));
  }
  if (fence) result.push({ type: "codeblock", value: fence.join("\n") });
  return result;
}
function parseInline(source: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const pattern =
    /(\*\*[^*]+\*\*|~~[^~]+~~|\+\+[^+]+\+\+|_[^_]+_|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|@\[([^\]]+)\]\(([0-9a-f-]{36})\)|@(all|here)\b)/gi;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor)
      nodes.push({ type: "text", value: source.slice(cursor, at) });
    const value = match[0];
    if (value.startsWith("**"))
      nodes.push({
        type: "strong",
        children: [{ type: "text", value: value.slice(2, -2) }],
      });
    else if (value.startsWith("_"))
      nodes.push({
        type: "emphasis",
        children: [{ type: "text", value: value.slice(1, -1) }],
      });
    else if (value.startsWith("~~"))
      nodes.push({
        type: "strike",
        children: [{ type: "text", value: value.slice(2, -2) }],
      });
    else if (value.startsWith("++"))
      nodes.push({
        type: "underline",
        children: [{ type: "text", value: value.slice(2, -2) }],
      });
    else if (value.startsWith("`"))
      nodes.push({
        type: "code",
        children: [{ type: "text", value: value.slice(1, -1) }],
      });
    else if (value.startsWith("@["))
      nodes.push({ type: "mention", label: match[2]!, actorID: match[3]! });
    else if (/^@(all|here)$/i.test(value))
      nodes.push({
        type: "contextMention",
        value: value.slice(1).toLowerCase() as "all" | "here",
      });
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)!;
      nodes.push({
        type: "link",
        href: link[2]!,
        children: [{ type: "text", value: link[1]! }],
      });
    }
    cursor = at + value.length;
  }
  if (cursor < source.length)
    nodes.push({ type: "text", value: source.slice(cursor) });
  return nodes;
}
