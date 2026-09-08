import { Suspense, lazy } from "react";
import type {
  Categories as EmojiCategory,
  EmojiStyle,
  Theme as EmojiTheme,
} from "emoji-picker-react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "../ui";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

export const quickReactions = ["👍", "✅", "🔥", "👀", "🙏"];

/** Lazily loaded emoji picker with localized categories and current theme. */
export function EmojiPickerPanel({
  height = 360,
  onPick,
}: {
  height?: number;
  onPick(emoji: string): void;
}) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<Skeleton shape="rect" height={height} />}>
      <EmojiPicker
        width="100%"
        height={height}
        categories={[
          { category: "suggested" as EmojiCategory, name: t("emojiSuggested") },
          { category: "smileys_people" as EmojiCategory, name: t("emojiSmileys") },
          { category: "animals_nature" as EmojiCategory, name: t("emojiAnimals") },
          { category: "food_drink" as EmojiCategory, name: t("emojiFood") },
          { category: "travel_places" as EmojiCategory, name: t("emojiTravel") },
          { category: "activities" as EmojiCategory, name: t("emojiActivities") },
          { category: "objects" as EmojiCategory, name: t("emojiObjects") },
          { category: "symbols" as EmojiCategory, name: t("emojiSymbols") },
          { category: "flags" as EmojiCategory, name: t("emojiFlags") },
        ]}
        theme={
          (document.documentElement.dataset.theme === "dark"
            ? "dark"
            : "light") as EmojiTheme
        }
        emojiStyle={"native" as EmojiStyle}
        lazyLoadEmojis
        searchPlaceholder={t("searchEmoji")}
        searchClearButtonLabel={t("clearSearch")}
        previewConfig={{ showPreview: false }}
        onEmojiClick={(selection) => onPick(selection.emoji)}
      />
    </Suspense>
  );
}
