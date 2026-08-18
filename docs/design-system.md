# ComaMessenger design system

## Direction

ComaMessenger uses a dense, calm workspace UI inspired by the information architecture of Pachca, not its brand assets or product copy. The interface is full-height and mostly flat: hierarchy comes from spacing, typography, borders and state changes rather than large cards, gradients or decorative shadows.

Primary references:

- live Pachca web application inspected on 18 August 2026;
- https://pachca.com/help-center/features/menu;
- https://pachca.com/help-center/features/actions-with-messages;
- https://pachca.com/help-center/features/papki;
- https://pachca.com/help-center/features/roli-v-chatah.

## Foundations

### Layout

- Desktop sidebar: `260px`, full viewport height, resizable later.
- Primary control height: `36px`; compact control height: `32px`.
- Sidebar row height: `34px`.
- Conversation header: `62px`.
- Content column: fluid; message content is capped at `820px` and centered.
- Mobile breakpoint: `720px`; sidebar becomes a compact rail until a proper mobile navigation is built.

### Typography

- Font: system sans stack.
- Base UI: `14px / 20px`, regular or medium.
- Secondary labels: `12–13px / 16–18px`.
- Screen headings: `18–24px`, weight `600`.
- Avoid oversized marketing headings inside the product shell.

### Radius scale

| Token | Value | Use |
| --- | ---: | --- |
| `xs` | 2px | tiny indicators |
| `sm` | 4px | compact state surfaces |
| `md` | 6px | buttons, inputs, nav rows |
| `lg` | 8px | composer, list icons |
| `xl` | 12px | dialogs, large icons |
| `2xl` | 16px | rare large surfaces |
| `full` | 999px | primary CTA, status chips, reactions |

### Dark color tokens

The web client stores colors in OKLCH so lightness and chroma can be adjusted predictably.

- background: `oklch(23.5% 0.007 271)`;
- secondary background: `oklch(25.7% 0.009 271)`;
- surface: `oklch(28.7% 0.011 271)`;
- high surface: `oklch(32.7% 0.014 271)`;
- foreground: `oklch(95% 0.008 271)`;
- muted: `oklch(75% 0.018 271)`;
- border: `oklch(32.6% 0.02 271)`;
- primary: `oklch(54.8% 0.25 271)`.

Light mode uses the same semantic token names. Components never hard-code theme-specific background or text colors.

## Components

### Buttons

- `primary`: filled primary color and pill shape; use for one main action per surface.
- `secondary`: bordered, compact rectangular control.
- `ghost`: icon and contextual actions with transparent idle state.
- `danger`: destructive actions only.
- Every icon-only button has an accessible label and tooltip/title.

### Inputs

- Labels stay above the field.
- Inputs are 40px high with 6px radius.
- Focus uses primary border plus a subtle 3px ring.
- Validation is rendered next to the form, never only as a toast.

### Sidebar

Order is stable: workspace switcher, global search/create, utility navigation, chat folders, profile. Group and channel chats are separated from direct conversations. Active rows use a solid primary background; unread state will later add a badge and stronger label weight.

### Chat header

Contains chat identity and topic, contextual search, kind badge, participants, information and overflow actions. A pinned-message strip can be inserted immediately below the header without changing the message viewport.

### Message row

- Messages are rows, not bubbles.
- First message in an author group shows avatar, author and time.
- Consecutive messages can collapse repeated identity and show time on hover.
- Hover toolbar contains reaction, thread and overflow actions.
- Reactions and thread entry points are compact pills below the message.
- Attachments, reply preview, edited state and delivery status occupy dedicated sub-rows.

### Composer

The composer is a bordered rectangular surface at the bottom of the conversation. Attachment actions are on the left; mentions, emoji and send are on the right. Phase 2 may grow it vertically, but the idle height remains 52px.

### Dialogs and menus

- Dialog width defaults to 480px with a 12px radius.
- Header and body are separated by a 1px semantic border.
- Popover menus use 6–8px radius, compact 34–36px rows and no decorative gradients.
- Destructive menu items form a separated group.

### Empty and loading states

Empty states use a small functional icon, one short heading and one sentence. Suggestions may appear as compact buttons. Avoid large illustrations, glass surfaces and promotional copy inside the application shell.

## Interaction states

Every interactive component must define idle, hover, active, focus-visible, disabled and loading states. Components that trigger a server mutation also need optimistic/pending and stable error states. Motion is limited to 120–160ms color and opacity transitions and must respect `prefers-reduced-motion`.

## Implementation

- Primitive React components live in `apps/web/src/ui.tsx`.
- Semantic tokens and component styles live in `apps/web/src/styles.css`.
- Product composition lives in `apps/web/src/App.tsx` until routing and feature modules are introduced.
- Icons come from `lucide-react`; Unicode characters are not used as interface icons.
