# Coma design system

## Direction

Coma uses a light, calm workspace UI with its own identity. Early information-architecture research included Pachca, but the production language is deliberately distinct: a pale navigation canvas, outlined content workspace, blue line selection, grouped quick navigation and a two-level composer. No Pachca brand assets or product copy are used.

Primary references:

- supplied Coma logo and brand color `#174586`;
- live Pachca web application inspected on 18 August 2026 only as competitive research;
- https://pachca.com/help-center/features/menu;
- https://pachca.com/help-center/features/actions-with-messages;
- https://pachca.com/help-center/features/papki;
- https://pachca.com/help-center/features/roli-v-chatah.

## Foundations

### Layout

- Desktop sidebar: `288px`, full viewport height, resizable later.
- Primary control height: `36px`; compact control height: `32px`.
- Sidebar row height: `34px`.
- Conversation header: `70px`.
- Content column: fluid; message content is capped at `880px` and centered.
- Mobile breakpoint: `760px`; sidebar becomes a compact rail until a proper mobile navigation is built.

### Typography

- Font: self-hosted variable Onest.
- Base UI: `14px / 20px`, regular or medium.
- Secondary labels: `12–13px / 16–18px`.
- Screen headings: `18–24px`, weight `600`.
- Avoid oversized marketing headings inside the product shell.

### Radius scale

| Token | Value | Use |
| --- | ---: | --- |
| `sm` | 6px | compact state surfaces |
| `md` | 9px | buttons, inputs, nav rows |
| `lg` | 12px | grouped controls, list icons |
| `xl` | 16px | dialogs and the conversation surface |
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

Order is stable: brand/workspace block, global search/create, a two-column utility area, chat groups and profile. Team chats are separated from direct conversations. Active rows use a pale surface and a blue line indicator instead of a filled selection.

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

## Interaction states

Every interactive component must define idle, hover, active, focus-visible, disabled and loading states. Components that trigger a server mutation also need optimistic/pending and stable error states. Motion is limited to 120–160ms color and opacity transitions and must respect `prefers-reduced-motion`.

## Implementation

- Primitive React components live in `apps/web/src/ui.tsx`.
- Semantic tokens and component styles live in `apps/web/src/styles.css`.
- Product composition lives in `apps/web/src/App.tsx` until routing and feature modules are introduced.
- Icons come from `lucide-react`; the supplied SVG is used only for the Coma brand mark. Unicode characters are not used as interface icons.
