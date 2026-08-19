import type { ReactNode } from "react";
import { parseMarkdown, type MarkdownNode } from "@comamessenger/core";

function node(value: MarkdownNode, index: number): ReactNode {
  if (value.type === "text") return value.value;
  if (value.type === "break") return <br key={index} />;
  if (value.type === "codeblock")
    return (
      <pre key={index}>
        <code>{value.value}</code>
      </pre>
    );
  if (value.type === "mention")
    return (
      <span className="mention" key={index}>
        @{value.label}
      </span>
    );
  if (value.type === "link")
    return (
      <a key={index} href={value.href} target="_blank" rel="noreferrer">
        {value.children.map(node)}
      </a>
    );
  if (value.type === "strong")
    return <strong key={index}>{value.children.map(node)}</strong>;
  if (value.type === "emphasis")
    return <em key={index}>{value.children.map(node)}</em>;
  return <code key={index}>{value.children.map(node)}</code>;
}
export function Markdown({ source }: { source: string }) {
  return <>{parseMarkdown(source).map(node)}</>;
}
