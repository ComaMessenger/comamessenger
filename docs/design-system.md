# Coma design system

## Direction

The approved visual source is [`design/prototypes/interface-lab/index.html`](../design/prototypes/interface-lab/index.html). It is an independent HTML concept inspired by common workspace UI patterns. No paid ReUI code, templates, icons or assets are included.

Coma uses neutral connected surfaces, fine semantic borders, Onest typography, compact rectangular controls, pastel avatars and a two-level composer. The same foundations apply to the web client, mobile web, iOS and Android. Existing routes, permissions, API contracts, offline queues and interaction capabilities are retained. See [`redesign/interface-lab-rollout.md`](../redesign/interface-lab-rollout.md) for implementation scope and ownership.

## Foundations

### Layout

- Desktop global navigation: `208px`, full viewport height; collapsed rail: `60px`.
- Desktop chat stream: `300px`, separate from global navigation. The columns connect through fine dividing borders rather than separate floating cards.
- Main web controls: `36px`; compact controls: `28–32px`; phone inputs and primary actions keep at least `44px` interaction areas.
- Content is fluid; messages retain bounded readable line lengths and virtual scrolling.
- At tablet widths up to `840px`, global navigation uses the compact rail. At `640px` and below, phone navigation shows one main screen at a time: chat list, conversation or thread.
- Native iOS/Android use safe areas, platform navigation and keyboard-aware layouts. Primary native controls are `48px` high; icon touch targets are at least `44px`.

### Typography

- Web: self-hosted variable Onest. Native: bundled Onest regular, medium, semibold and bold.
- Body/UI: `14px / 20–21px`; compact metadata: `11–12px / 16–18px`; section headings: `17–18px`; page headings: `24px`, weight `600`.
- Native body/input text is typically `16px`, keeping Dynamic Type support and larger touch targets.
- Regular and medium weights do most work; semibold establishes hierarchy. Avoid oversized marketing headings in the product shell.
- Align control contents with flex/grid. Timestamp/count styles use tabular numerals.
- Fallbacks include system sans, Cyrillic and CJK families; long content must not expand layout columns.

### Radius scale

| Token  | Value | Use                                          |
| ------ | ----: | -------------------------------------------- |
| `sm`   |   6px | compact chips, menu items, state surfaces    |
| `md`   |   8px | buttons, inputs, nav rows                    |
| `lg`   |  12px | cards, composer, grouped controls            |
| `xl`   |  16px | dialogs and larger overlays                  |
| `full` | 999px | presence dots, avatar circles, switch tracks |

### Semantic colors

| Role                             | Light     | Dark      |
| -------------------------------- | --------- | --------- |
| Canvas                           | `#f6f6f7` | `#151517` |
| Sidebar/subtle surface           | `#fafafa` | `#222225` |
| Main surface                     | `#ffffff` | `#1d1d20` |
| Raised surface                   | `#ffffff` | `#27272c` |
| Foreground                       | `#202023` | `#f0f0f2` |
| Muted text                       | `#686873` | `#a0a0aa` |
| Border                           | `#e5e5e9` | `#323237` |
| Strong border                    | `#d2d2d9` | `#46464f` |
| Brand accent (`primary`)         | `#174586` | `#86aff0` |
| Main action (`action`)           | `#252528` | `#eeeeef` |
| Text on main action (`onAction`) | `#ffffff` | `#222225` |

`primary` remains the workspace accent for links, selection, focus and presence of an active feature. `action` is separate: primary buttons use a neutral high-contrast fill in both themes. Custom workspace branding changes the accent, preserving neutral action buttons. Semantic success, warning, danger and info colors accompany text, never carry meaning alone.

Avatars have stable seeded `avatarSurface1..8` / `avatarForeground1..8` pairs. Images replace initials when an uploaded avatar is available.

### Dark color and elevation policy

- Dark mode uses neutral charcoal surfaces, not a blue-tinted canvas.
- No decorative glow, gradients, text glow or luminous shadows. Surface contrast and semantic borders communicate depth; light-mode shadows remain subtle.
- Focus visibility uses a bounded outline/ring and is preserved under reduced motion.
- Short state transitions use `120–140ms`; respect system reduced-motion preferences.

## Components

### Buttons

- `primary`: neutral `action` fill with `onAction` text and an 8px radius; use for one main action per surface.
- `secondary`: bordered, compact rectangular control.
- `ghost`: icon and contextual actions with transparent idle state.
- `danger`: destructive actions only.
- Every icon-only button has an accessible label and tooltip/title.

### Inputs

- Labels stay above the field.
- Inputs are 36px high on desktop and at least 44px on phone, with an 8px radius.
- Focus uses the primary accent border plus a subtle 2px ring.
- Validation is rendered next to the form, never only as a toast.

### Sidebar

The desktop shell has three independent regions:

1. permanent global navigation;
2. chat stream, present only on chat routes;
3. the working area, where a conversation, Threads, Important or Members is rendered.

Global navigation order is stable: Coma logo plus ellipsized workspace name, flat search plus accent create button, `Чаты`, `Треды`, `Важные`, `Участники`, then the current profile. It never turns into a chat list and never changes when a utility section opens. Workspace settings and sign-out live in the workspace switcher menu; `Настройки` is not a navigation item.

The profile block is anchored to the viewport bottom rather than following navigation content. On desktop the global navigation can collapse to a `60px` icon rail; the preference is local to the browser. Workspace and profile menus remain available next to the compact rail. Collapse never changes the chat stream, selected route or conversation state.

Search uses a flat semantic surface with no inner/outer shadow. The adjacent create button uses the neutral main-action fill. The workspace menu shows account identity, the current workspace and role-gated workspace settings.

The chat stream is continuous, compact and independently scrollable. Rows follow a familiar Telegram-like information hierarchy without copying its assets: circular avatar, title and notification state, time, two-line preview and unread count. There is no visible overflow button. The chat menu opens by right click, keyboard context-menu command or touch long press, and provides pinning, notification state, read state, personal folder membership and leave actions. A muted chat shows `BellOff` beside its title; channel kind is not repeated with a megaphone icon.

Its first filters are always `Все`, `Личные`, `Групповые`, `Каналы`; user-created folders follow them. A folder has a name, one of the curated semantic icons, a semantic color and an explicit set of chats, all persisted in user preferences. Icon selection is a searchable grid rather than a native select. Chat search filters the currently selected system filter or personal folder.

A user may pin at most ten chats. Folder membership is resolved before pin ordering: a pinned chat rises to the top of every filter it belongs to, but never appears in a personal folder that does not contain it. Pinning is personal and does not alter organization-wide chat metadata.

### Phone chat list

Phone Web uses a familiar messenger list pattern without copying Telegram assets, spacing or chrome:

- a full-width screen replaces the desktop sidebar;
- filter chips start with `Все`, `Личные`, `Групповые`, `Каналы`, with `Все` selected by default; personal folders continue the same horizontal row;
- `Личные` maps to `kind=direct`, `Групповые` to `kind=group`, and `Каналы` to `kind=channel`;
- each card is at least `72px` high and contains a `48px` avatar, title, bounded preview, locale-formatted time and unread/mention state;
- avatars use uploaded images where available, with initials and a stable pastel semantic seed as fallback;
- title and time occupy one row; preview and unread badge occupy the second row; text containers have `min-width: 0`;
- touch targets are at least `44px`, and the list respects `safe-area-inset-*`;
- opening a card navigates to the conversation screen; conversation and thread have an explicit Back action and preserve list scroll/filter state.

Phone filter state lives in the typed `/chats?filter=all|direct|grouped|channel` route search; a personal folder uses `/chats?folder=<uuid>`. A direct deep link to a conversation returns to `/chats` when browser history has no in-app list entry. Desktop and phone use the same route tree and data store; only layout composition changes at the breakpoint. Utility pages retain a compact mobile navigation header, so moving between Threads, Important, Members and Chats never strands the user.

Large cards are a phone-only density choice. Desktop uses the same chat-stream information hierarchy at compact density.

### Phone tabbar and settings

At phone width the global sidebar becomes a fixed five-item bottom tabbar: Chats, Threads, Important, Members and More. It is route-driven, icon-only with accessible names, and reserves its own safe-area space instead of overlaying list rows or the composer. Opening a chat or thread does not discard the tabbar; Back still returns to the previous list context.

More is a full-height scrollable route, not a floating menu. Profile and workspace settings also render in the inset working area on desktop and as full screens above the tabbar on phone. Dialogs are reserved for bounded confirmations and browser permission flows, not application settings.

### Settings layout

- Settings use one centered content column capped at `680px`; sections follow reading order and never form a multi-column card dashboard.
- `SettingsShell` owns the page header and permission-aware primary/subsection navigation. A registered settings route must remain directly addressable on desktop and phone.
- `SettingsRow` is the default preference primitive: title and explanation form one text block, while the control occupies a stable action area. Narrow screens stack the control below the text.
- Boolean preferences use the shared accessible switch appearance with a visible focus state; a browser-native checkbox is not exposed as the finished product control.
- Forms keep labels above fields. Related fields may share a compact row only while there is enough width; phone layout stacks them and gives actions the full available width.
- Lists with multiple actions, including invitations and push diagnostics, collapse to one column on phone so controls never overlap and each touch target remains at least `44px`.
- Autosave state is shown in the page, and server mutation failures remain visible next to the affected settings rather than existing only as transient notifications.
- Notification diagnostics distinguish server readiness, browser permission and registered devices. Per-chat overrides are visibly separate from global defaults and can be reset as a group.

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
- Popover menus use an 8–12px radius, compact 34–36px rows and no decorative gradients.
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

- Shared semantic tokens live in `packages/tokens` as platform-neutral typed data with matching Web CSS custom properties. Native iOS/Android consume the same typed themes.
- Primitive React components remain Web-native in `apps/web`; a cross-platform `@coma/ui` package is not created in phase 3.
- Component styles live in `apps/web` and reference semantic variables; domain components do not contain raw palette values.
- Product composition is split into feature modules under `apps/web/src`: `auth/`, `shell/` (messenger shell, realtime session, global sidebar), `chats/`, `conversation/`, `composer/`, `dialogs/`, `directories/`; `settings/` and `agents/` keep their own layout. `App.tsx` only resolves the server state and picks a screen.
- Styles are split per module in `apps/web/src/styles/` (`index.css` imports them in order); primitives live in `ui.css`, legacy settings/agents styles in `settings.css` and `agents.css`.
- Translations: base catalogs in `apps/web/src/i18n/{ru,en}.ts`; each feature module adds its own keys in `<module>/i18n.ts` through `defineCatalog` (duplicate keys throw in dev).
- The redesign reference (Claude Design canvases) is stored in `design/claude-design/`; gaps between the mockups and the current API are tracked in `redesign/`.
- Icons come from `lucide-react`; the supplied SVG is used only for the Coma brand mark. Unicode characters are not used as interface icons.
- Shared client engine, store, outbox and markdown AST follow [ADR-0009](decisions/0009-client-engine-and-platform-ui.md).
