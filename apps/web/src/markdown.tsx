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
  if (value.type === "contextMention")
    return (
      <span className="mention mention--context" key={index}>
        @{value.value}
      </span>
    );
  if (value.type === "heading") {
    const content = value.children.map(node);
    if (value.level === 1) return <h1 key={index}>{content}</h1>;
    if (value.level === 2) return <h2 key={index}>{content}</h2>;
    return <h3 key={index}>{content}</h3>;
  }
  if (value.type === "list") {
    const items = value.items.map((item, itemIndex) => (
      <li key={itemIndex}>{item.map(node)}</li>
    ));
    return value.ordered ? (
      <ol key={index}>{items}</ol>
    ) : (
      <ul key={index}>{items}</ul>
    );
  }
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
  if (value.type === "underline")
    return <u key={index}>{value.children.map(node)}</u>;
  if (value.type === "strike")
    return <s key={index}>{value.children.map(node)}</s>;
  return <code key={index}>{value.children.map(node)}</code>;
}
export function Markdown({ source }: { source: string }) {
  return <>{parseMarkdown(source).map(node)}</>;
}
