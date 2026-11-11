import { Fragment, useMemo, type ReactNode } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { parseMarkdown, type MarkdownNode } from "@comamessenger/core";
import { radius, spacing, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text, fonts } from "@/ui/Text";

const monospace = Platform.select({ ios: "Menlo", default: "monospace" });
const blockTypes = new Set(["codeblock", "heading", "list"]);

/** Colours of Markdown on its background: the feed or the reader's own bubble. */
export type MarkdownPalette = {
  text: string;
  muted: string;
  accent: string;
  code: string;
  codeBorder: string;
};

export function markdownPalette(
  theme: ThemeTokens,
  own = false,
): MarkdownPalette {
  return own
    ? {
        text: theme.onOwn,
        muted: theme.ownMuted,
        accent: theme.onOwn,
        code: theme.ownTrack,
        codeBorder: "transparent",
      }
    : {
        text: theme.foreground,
        muted: theme.muted,
        accent: theme.primary,
        code: theme.sidebar,
        codeBorder: theme.border,
      };
}

function inline(
  node: MarkdownNode,
  key: number,
  palette: MarkdownPalette,
): ReactNode {
  const children = (nodes: MarkdownNode[]) =>
    nodes.map((child, index) => inline(child, index, palette));
  switch (node.type) {
    case "text":
      return node.value;
    case "break":
      return "\n";
    case "strong":
      return (
        <Text key={key} weight="semibold" style={{ color: palette.text }}>
          {children(node.children)}
        </Text>
      );
    case "emphasis":
      return (
        <Text key={key} style={[styles.italic, { color: palette.text }]}>
          {children(node.children)}
        </Text>
      );
    case "underline":
      return (
        <Text key={key} style={[styles.underline, { color: palette.text }]}>
          {children(node.children)}
        </Text>
      );
    case "strike":
      return (
        <Text key={key} style={[styles.strike, { color: palette.text }]}>
          {children(node.children)}
        </Text>
      );
    case "code":
      return (
        <Text
          key={key}
          style={[
            styles.inlineCode,
            { backgroundColor: palette.code, color: palette.text },
          ]}
        >
          {children(node.children)}
        </Text>
      );
    case "link":
      return (
        <Text
          key={key}
          accessibilityRole="link"
          style={[styles.underline, { color: palette.accent }]}
          onPress={() => void Linking.openURL(node.href)}
        >
          {children(node.children)}
        </Text>
      );
    case "mention":
      return (
        <Text key={key} weight="semibold" style={{ color: palette.accent }}>
          @{node.label}
        </Text>
      );
    case "contextMention":
      return (
        <Text key={key} weight="semibold" style={{ color: palette.accent }}>
          @{node.value}
        </Text>
      );
    default:
      return null;
  }
}

/** Renders the shared Markdown AST with native text; never through HTML. */
export function Markdown({
  source,
  own = false,
  size = 16,
}: {
  source: string;
  /** Drawn on the reader's own bubble. */
  own?: boolean;
  size?: number;
}) {
  const theme = useTheme();
  const palette = markdownPalette(theme, own);
  const color = { color: palette.text };
  const nodes = useMemo(() => parseMarkdown(source), [source]);

  // Consecutive inline nodes share one Text so they wrap as a paragraph.
  const blocks: ReactNode[] = [];
  let paragraph: ReactNode[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(
      <Text key={`p${blocks.length}`} size={size} style={color}>
        {paragraph}
      </Text>,
    );
    paragraph = [];
  };
  nodes.forEach((node, index) => {
    if (!blockTypes.has(node.type)) {
      paragraph.push(
        <Fragment key={index}>{inline(node, index, palette)}</Fragment>,
      );
      return;
    }
    flush();
    if (node.type === "codeblock")
      blocks.push(
        <View
          key={index}
          style={[
            styles.codeblock,
            { backgroundColor: palette.code, borderColor: palette.codeBorder },
          ]}
        >
          <Text size={14} style={[color, { fontFamily: monospace }]}>
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
          style={color}
        >
          {node.children.map((child, childIndex) =>
            inline(child, childIndex, palette),
          )}
        </Text>,
      );
    else if (node.type === "list")
      blocks.push(
        <View key={index} style={styles.list}>
          {node.items.map((item, itemIndex) => (
            <View key={itemIndex} style={styles.listItem}>
              <Text
                size={size}
                style={[styles.marker, { color: palette.muted }]}
              >
                {node.ordered ? `${itemIndex + 1}.` : "•"}
              </Text>
              <Text size={size} style={[styles.grow, color]}>
                {item.map((child, childIndex) =>
                  inline(child, childIndex, palette),
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
  codeblock: { borderRadius: radius.md, borderWidth: 1, padding: spacing[3] },
  list: { gap: 2 },
  listItem: { flexDirection: "row", gap: spacing[2] },
  marker: { minWidth: 16, fontFamily: fonts.regular },
  grow: { flex: 1 },
});
