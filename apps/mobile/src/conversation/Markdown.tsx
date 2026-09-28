import { Fragment, useMemo, type ReactNode } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { parseMarkdown, type MarkdownNode } from "@comamessenger/core";
import { radius, spacing, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text, fonts } from "@/ui/Text";

const monospace = Platform.select({ ios: "Menlo", default: "monospace" });
const blockTypes = new Set(["codeblock", "heading", "list"]);

function inline(
  node: MarkdownNode,
  key: number,
  theme: ThemeTokens,
): ReactNode {
  const children = (nodes: MarkdownNode[]) =>
    nodes.map((child, index) => inline(child, index, theme));
  switch (node.type) {
    case "text":
      return node.value;
    case "break":
      return "\n";
    case "strong":
      return (
        <Text key={key} weight="semibold">
          {children(node.children)}
        </Text>
      );
    case "emphasis":
      return (
        <Text key={key} style={styles.italic}>
          {children(node.children)}
        </Text>
      );
    case "underline":
      return (
        <Text key={key} style={styles.underline}>
          {children(node.children)}
        </Text>
      );
    case "strike":
      return (
        <Text key={key} style={styles.strike}>
          {children(node.children)}
        </Text>
      );
    case "code":
      return (
        <Text
          key={key}
          style={[styles.inlineCode, { backgroundColor: theme.sidebar }]}
        >
          {children(node.children)}
        </Text>
      );
    case "link":
      return (
        <Text
          key={key}
          accessibilityRole="link"
          tone="primary"
          style={styles.underline}
          onPress={() => void Linking.openURL(node.href)}
        >
          {children(node.children)}
        </Text>
      );
    case "mention":
      return (
        <Text key={key} tone="primary" weight="medium">
          @{node.label}
        </Text>
      );
    case "contextMention":
      return (
        <Text key={key} tone="primary" weight="medium">
          @{node.value}
        </Text>
      );
    default:
      return null;
  }
}

/** Renders the shared Markdown AST with native text; never through HTML. */
export function Markdown({ source }: { source: string }) {
  const theme = useTheme();
  const nodes = useMemo(() => parseMarkdown(source), [source]);

  // Consecutive inline nodes share one Text so they wrap as a paragraph.
  const blocks: ReactNode[] = [];
  let paragraph: ReactNode[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(
      <Text key={`p${blocks.length}`} size={16}>
        {paragraph}
      </Text>,
    );
    paragraph = [];
  };
  nodes.forEach((node, index) => {
    if (!blockTypes.has(node.type)) {
      paragraph.push(
        <Fragment key={index}>{inline(node, index, theme)}</Fragment>,
      );
      return;
    }
    flush();
    if (node.type === "codeblock")
      blocks.push(
        <View
          key={index}
          style={[styles.codeblock, { backgroundColor: theme.sidebar }]}
        >
          <Text size={14} style={{ fontFamily: monospace }}>
            {node.value}
          </Text>
        </View>,
      );
    else if (node.type === "heading")
      blocks.push(
        <Text
          key={index}
          accessibilityRole="header"
          weight="bold"
          size={node.level === 1 ? 20 : node.level === 2 ? 18 : 17}
        >
          {node.children.map((child, childIndex) =>
            inline(child, childIndex, theme),
          )}
        </Text>,
      );
    else if (node.type === "list")
      blocks.push(
        <View key={index} style={styles.list}>
          {node.items.map((item, itemIndex) => (
            <View key={itemIndex} style={styles.listItem}>
              <Text size={16} tone="muted" style={styles.marker}>
                {node.ordered ? `${itemIndex + 1}.` : "•"}
              </Text>
              <Text size={16} style={styles.grow}>
                {item.map((child, childIndex) =>
                  inline(child, childIndex, theme),
                )}
              </Text>
            </View>
          ))}
        </View>,
      );
  });
  flush();
  return <View style={styles.body}>{blocks}</View>;
}

const styles = StyleSheet.create({
  body: { gap: spacing[1] },
  italic: { fontStyle: "italic" },
  underline: { textDecorationLine: "underline" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: monospace, fontSize: 14 },
  codeblock: { borderRadius: radius.md, padding: spacing[3] },
  list: { gap: 2 },
  listItem: { flexDirection: "row", gap: spacing[2] },
  marker: { minWidth: 16, fontFamily: fonts.regular },
  grow: { flex: 1 },
});
