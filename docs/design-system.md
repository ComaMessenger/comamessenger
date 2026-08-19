# Coma design system

## Direction

Coma uses a calm workspace UI with its own identity. Early information-architecture research included Pachca, but the production language is deliberately distinct: a permanent compact navigation rail, a Telegram-like chat stream, an inset content workspace and a two-level composer. No Pachca brand assets or product copy are used.

Primary references:

- supplied Coma logo and brand color `#174586`;
- live Pachca web application inspected on 18 August 2026 only as competitive research;
- https://pachca.com/help-center/features/menu;
- https://pachca.com/help-center/features/actions-with-messages;
- https://pachca.com/help-center/features/papki;
- https://pachca.com/help-center/features/roli-v-chatah.

## Foundations

### Layout

- Desktop global navigation: `220px`, full viewport height.
- Desktop chat stream: `320px`; it is a separate region rather than part of global navigation.
- Primary control height: `36px`; compact control height: `32px`.
- Sidebar row height: `34px`.
- Conversation header: `70px`.
- Content column: fluid; message content is capped at `880px` and centered.
- Phone breakpoint: `640px`; desktop columns заменяются navigation stack, а не сжимаются в compact rail.
- Tablet может временно скрывать sidebar по route/state; phone одновременно показывает ровно один основной экран: chat list, conversation или thread.

### Typography

- Font: self-hosted variable Onest.
- Base UI: `14px / 20px`, regular or medium.
- Secondary labels: `12–13px / 16–18px`.
- Screen headings: `18–24px`, weight `600`.
- Avoid oversized marketing headings inside the product shell.
- Body line-height token is `1.5`; vertical centering controls use flex/grid alignment, never a line-height equal to control height.
- Font fallback: `"Onest Variable", Onest, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`.
- Timestamp/count styles use `font-variant-numeric: tabular-nums`.

### Radius scale

| Token  | Value | Use                                  |
| ------ | ----: | ------------------------------------ |
| `sm`   |   6px | compact state surfaces               |
| `md`   |   9px | buttons, inputs, nav rows            |
| `lg`   |  12px | grouped controls, list icons         |
| `xl`   |  16px | dialogs and the conversation surface |
| `full` | 999px | primary CTA, status chips, reactions |

### Light color tokens

The default product theme is light and derives its accent from the supplied logo.

- canvas: `#f3f6fa`;
- sidebar: `#eef3f8`;
- background and surface: `#ffffff`;
- foreground: `#182235`;
- muted: `#6b788b`;
- border: `#dce3ec`;
- primary: `#174586`;
- primary soft: `#e3edf9`.

### Dark color and elevation policy

- Dark mode uses neutral charcoal surfaces; blue remains an action/selection accent rather than tinting the canvas.
- Dark mode does not use decorative glow, text glow or luminous drop shadows. Depth is communicated by surface contrast and semantic borders.
- Focus visibility remains mandatory, but uses an outline/ring with bounded opacity instead of a diffuse glow.

## Components

### Buttons

- `primary`: filled primary color with a 9px radius; use for one main action per surface.
- `secondary`: bordered, compact rectangular control.
- `ghost`: icon and contextual actions with transparent idle state.
- `danger`: destructive actions only.
- Every icon-only button has an accessible label and tooltip/title.

### Inputs

- Labels stay above the field.
- Inputs are 42px high with 9px radius.
- Focus uses primary border plus a subtle 3px ring.
- Validation is rendered next to the form, never only as a toast.

### Sidebar

The desktop shell has three independent regions:

1. permanent global navigation;
2. chat stream, present only on chat routes;
3. the working area, where a conversation, Threads, Important or Members is rendered.

Global navigation order is stable: Coma logo plus ellipsized workspace name, flat search plus accent create button, `Чаты`, `Треды`, `Важные`, `Участники`, then the current profile. It never turns into a chat list and never changes when a utility section opens. Workspace settings and sign-out live in the workspace switcher menu; `Настройки` is not a navigation item.

The profile block is anchored to the viewport bottom rather than following navigation content. On desktop the global navigation can collapse to a `58px` icon rail; the preference is local to the browser and expanding the workspace switcher restores the full rail before opening its menu. Collapse never changes the chat stream, selected route or conversation state.

Search uses a flat semantic surface with no inner/outer shadow. The adjacent create button uses the primary accent. The workspace menu shows account identity, the current workspace and role-gated workspace settings.

The chat stream is continuous, compact and independently scrollable. Rows follow a familiar Telegram-like information hierarchy without copying its assets: circular avatar, title and notification state, time, two-line preview and unread count. There is no visible overflow button. The chat menu opens by right click, keyboard context-menu command or touch long press, and provides pinning, notification state, read state, personal folder membership and leave actions. A muted chat shows `BellOff` beside its title; channel kind is not repeated with a megaphone icon.

Its first filters are always `Все`, `Личные`, `Групповые`, `Каналы`; user-created folders follow them. A folder has a name, one of the curated semantic icons, a semantic color and an explicit set of chats, all persisted in user preferences. Icon selection is a searchable grid rather than a native select. Chat search filters the currently selected system filter or personal folder.

A user may pin at most ten chats. Folder membership is resolved before pin ordering: a pinned chat rises to the top of every filter it belongs to, but never appears in a personal folder that does not contain it. Pinning is personal and does not alter organization-wide chat metadata.

### Phone chat list

Phone Web uses a familiar messenger list pattern without copying Telegram assets, spacing or chrome:

- a full-width screen replaces the desktop sidebar;
- filter chips start with `Все`, `Личные`, `Групповые`, `Каналы`, with `Все` selected by default; personal folders continue the same horizontal row;
- `Личные` maps to `kind=direct`, `Групповые` to `kind=group`, and `Каналы` to `kind=channel`;
- each card is at least `72px` high and contains a `48px` avatar, title, bounded preview, locale-formatted time and unread/mention state;
- until file avatars ship in phase 4, avatar uses initials and a stable semantic color seed, not a random color per render;
- title and time occupy one row; preview and unread badge occupy the second row; text containers have `min-width: 0`;
- touch targets are at least `44px`, and the list respects `safe-area-inset-*`;
- opening a card navigates to the conversation screen; conversation and thread have an explicit Back action and preserve list scroll/filter state.

Phone filter state lives in the typed `/chats?filter=all|direct|grouped|channel` route search; a personal folder uses `/chats?folder=<uuid>`. A direct deep link to a conversation returns to `/chats` when browser history has no in-app list entry. Desktop and phone use the same route tree and data store; only layout composition changes at the breakpoint. Utility pages retain a compact mobile navigation header, so moving between Threads, Important, Members and Chats never strands the user.

Large cards are a phone-only density choice. Desktop uses the same chat-stream information hierarchy at compact density.

### Phone tabbar and settings

At phone width the global sidebar becomes a fixed five-item bottom tabbar: Chats, Threads, Important, Members and More. It is route-driven, icon-only with accessible names, and reserves its own safe-area space instead of overlaying list rows or the composer. Opening a chat or thread does not discard the tabbar; Back still returns to the previous list context.

More is a full-height scrollable route, not a floating menu. Profile and workspace settings also render in the inset working area on desktop and as full screens above the tabbar on phone. Dialogs are reserved for bounded confirmations and browser permission flows, not application settings.

### Chat header

Contains chat identity, topic and kind plus a grouped action cluster on the right. Search is icon-only instead of occupying the center of the header. A pinned-message strip can be inserted immediately below the header without changing the message viewport.

### Message row

- Messages are rows, not bubbles.
- First message in an author group shows avatar, author and time.
- Consecutive messages can collapse repeated identity and show time on hover.
- Hover toolbar contains reaction, thread and overflow actions.
- Reactions and thread entry points are compact pills below the message.
- Attachments, reply preview, edited state and delivery status occupy dedicated sub-rows.

### Composer

The composer is a floating two-level surface: text entry occupies the upper row and tools occupy a separate lower toolbar. This gives Coma a recognisable silhouette and leaves room for formatting, attachments and AI actions in later phases.

### Dialogs and menus

- Dialog width defaults to 500px with a 16px radius.
- Header and body are separated by a 1px semantic border.
- Popover menus use a 9–12px radius, compact 34–36px rows and no decorative gradients.
- Destructive menu items form a separated group.

### Empty and loading states

Empty states use a small functional icon, one short heading and one sentence. Suggestions may appear as compact buttons. Avoid large illustrations, glass surfaces and promotional copy inside the application shell.

## Интернационализация layout

Эти правила применяются к primitives и входят в component review, а не исправляются отдельно после появления новых переводов:

1. Размер элемента следует за содержимым, ограничение задаёт контейнер. У переводимого текста нет fixed width; controls используют `min-inline-size`/`max-inline-size`.
2. У каждого текстового flex/grid child задан `min-width: 0`, чтобы длинное имя не расширяло колонку.
3. Для каждой однострочной строки явно выбрана политика: ellipsis либо line-clamp на 1–2 строки. Неявного `nowrap` нет.
4. Пользовательский контент использует `overflow-wrap: anywhere`; длинные URL не расширяют message viewport.
5. Form label располагается над field. Горизонтальная label/input пара не является базовым layout.
6. Для spacing/position используются logical properties: `padding-inline`, `margin-block`, `inset-inline-start` и аналоги.
7. CJK и fallback glyphs центрируются flex/grid; line-height не используется как alignment hack.
8. Переводимые строки не получают `text-transform: uppercase`; акцент задаётся weight/color.
9. `<html lang>` обновляется вместе с locale, чтобы браузер, переносы и screen reader использовали правильный язык.
10. Timestamp и metadata columns используют intrinsic `max-content`, поскольку `14:32`, `2:32 PM` и `下午2:32` имеют разную ширину.
11. Unread badge рассчитан минимум на `99+`; plural forms формируются только ICU message catalog.
12. Empty states и tooltips многострочны по умолчанию и ограничены viewport/container.

Generated pseudo-locale удлиняет каждую строку примерно на 40% и оборачивает её в заметные markers. Component catalog, visual regression и основные phone/desktop сценарии прогоняются в RU, EN и pseudo-locale. Короткие CJK labels проверяются отдельно: `min-inline-size` не даёт интерактивным элементам схлопнуться.

## Interaction states

Every interactive component must define idle, hover, active, focus-visible, disabled and loading states. Components that trigger a server mutation also need optimistic/pending and stable error states. Motion is limited to 120–160ms color and opacity transitions and must respect `prefers-reduced-motion`.

## Implementation

- Source-of-truth semantic tokens live in `packages/tokens` as platform-neutral typed data; Web consumes generated CSS custom properties.
- Primitive React components remain Web-native in `apps/web`; a cross-platform `@coma/ui` package is not created in phase 3.
- Component styles live in `apps/web` and reference semantic variables; domain components do not contain raw palette values.
- Product composition lives in `apps/web/src/App.tsx` until routing and feature modules are introduced.
- Icons come from `lucide-react`; the supplied SVG is used only for the Coma brand mark. Unicode characters are not used as interface icons.
- Shared client engine, store, outbox and markdown AST follow [ADR-0009](decisions/0009-client-engine-and-platform-ui.md).
