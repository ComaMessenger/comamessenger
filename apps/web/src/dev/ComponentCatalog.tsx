import { useEffect, useState } from "react";
import { Layers, MessageCircle, Moon, Plus, Sun } from "lucide-react";
import {
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Chip,
  Dialog,
  EmptyState,
  Field,
  FormError,
  IconButton,
  InkCard,
  InlineError,
  InlineSuccess,
  Menu,
  MenuItem,
  Popover,
  Segmented,
  Skeleton,
  Switch,
  Tabs,
  Tag,
  TextareaField,
  Toast,
  Tooltip,
} from "../ui";

const colorTokens = [
  ["Canvas", "canvas"],
  ["Surface", "surface"],
  ["Border", "border"],
  ["Muted", "muted"],
  ["Foreground", "foreground"],
  ["Accent", "primary"],
] as const;

/** The production primitives, in the Interface Lab visual language. */
export function ComponentCatalog() {
  const [dialog, setDialog] = useState(false);
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState<"a" | "b">("a");
  const [segment, setSegment] = useState<"all" | "mentions" | "none">("all");
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme ?? "light",
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme ?? "light"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <main className="component-catalog">
      <div className="component-catalog__inner">
        <header className="component-catalog__head">
          <div>
            <span className="component-catalog__eyebrow">
              <Layers size={14} /> Interface Lab / Design system
            </span>
            <h1>Coma UI</h1>
            <p>
              Shared UI foundations. Quiet surfaces, clear states and the Coma
              accent.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              document.documentElement.dataset.theme =
                theme === "dark" ? "light" : "dark";
            }}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </Button>
        </header>
        <section className="component-catalog__foundations">
          <div className="component-catalog__section-head">
            <h2>Foundations</h2>
            <span>Semantic colors · Onest · 4 px rhythm</span>
          </div>
          <div className="component-catalog__palette">
            {colorTokens.map(([label, token]) => (
              <div key={token} className="component-catalog__color">
                <span style={{ background: `var(--coma-${token})` }} />
                <strong>{label}</strong>
                <code>--coma-{token}</code>
              </div>
            ))}
          </div>
        </section>
        <div className="component-catalog__grid">
          <section>
            <div className="component-catalog__section-head">
              <h2>Actions</h2>
              <span>01 / Button</span>
            </div>
            <div className="component-catalog__row">
              <Button variant="primary">Primary</Button>
              <Button>Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="component-catalog__row">
              <Button variant="primary" pending>
                Pending
              </Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
              <IconButton label="Icon">
                <MessageCircle />
              </IconButton>
              <Tooltip text="Helpful context">
                <Button size="sm">Tooltip</Button>
              </Tooltip>
              <Button onClick={() => setDialog(true)}>
                <Plus />
                Dialog
              </Button>
            </div>
          </section>
          <section>
            <div className="component-catalog__section-head">
              <h2>Identity & status</h2>
              <span>02 / Avatar · Badge</span>
            </div>
            <div className="component-catalog__row">
              <Avatar name="Sample User" size="lg" online />
              <Avatar name="Coma Assistant" size="lg" agent />
              <Avatar name="Away Person" size="lg" presence="away" />
              <AvatarStack>
                <Avatar name="Anna Smirnova" />
                <Avatar name="Mikhail Volkov" />
                <Avatar name="Lev Pavlov" />
              </AvatarStack>
            </div>
            <div className="component-catalog__row">
              <Badge tone="primary">99+</Badge>
              <Badge>3</Badge>
              <Badge tone="success">Saved</Badge>
              <Tag tone="agent">AI agent</Tag>
              <Chip active>Active chip</Chip>
              <Chip dot="green">Folder</Chip>
              <Switch checked={on} onChange={setOn} label="Switch" />
            </div>
          </section>
          <section className="component-catalog__form">
            <div className="component-catalog__section-head">
              <h2>Form</h2>
              <span>03 / Field · Selection</span>
            </div>
            <Field
              label="Text field"
              name="catalog"
              placeholder="Long localized content"
              hint="Labels stay above fields; supporting text stays nearby."
            />
            <Field
              label="With error"
              name="catalog-error"
              error="Something is wrong"
            />
            <TextareaField
              label="Message"
              name="message"
              placeholder="Message your team…"
            />
            <Tabs<"a" | "b">
              label="Tabs"
              value={tab}
              onChange={setTab}
              items={[
                { id: "a", label: "Chats and people" },
                { id: "b", label: "Messages and threads" },
              ]}
            />
            <Segmented<"all" | "mentions" | "none">
              label="Segmented"
              value={segment}
              onChange={setSegment}
              items={[
                { id: "all", label: "All" },
                { id: "mentions", label: "Mentions" },
                { id: "none", label: "Off" },
              ]}
            />
          </section>
          <section className="component-catalog__states">
            <div className="component-catalog__section-head">
              <h2>Feedback</h2>
              <span>04 / Loading · Error · Success</span>
            </div>
            <Skeleton width={180} height={32} shape="rect" />
            <FormError message="Example error state" />
            <InlineError
              title="Could not refresh"
              hint="Showing saved data"
              retryLabel="Retry"
              onRetry={() => undefined}
            />
            <InlineSuccess title="Saved successfully" />
            <InkCard title="Workspace hint">
              A quiet supporting surface for context and next steps.
            </InkCard>
            <Toast tone="success">Saved successfully</Toast>
            <Toast
              ink
              action={
                <button type="button" className="ui-toast__action">
                  Undo
                </button>
              }
            >
              Message pinned
            </Toast>
          </section>
          <section>
            <div className="component-catalog__section-head">
              <h2>Empty state</h2>
              <span>05 / Content</span>
            </div>
            <EmptyState title="Nothing here" hint="Empty state hint" />
          </section>
          <section className="component-catalog__overlays">
            <div className="component-catalog__section-head">
              <h2>Menus & popovers</h2>
              <span>06 / Overlay</span>
            </div>
            <Popover>Popover content can wrap across lines.</Popover>
            <Menu label="Example menu">
              <MenuItem>Menu item</MenuItem>
              <MenuItem danger>Danger item</MenuItem>
            </Menu>
          </section>
        </div>
        <footer className="component-catalog__foot">
          Coma Interface Lab · Production components
          <span>Light / Dark · Desktop / Phone</span>
        </footer>
      </div>
      {dialog && (
        <Dialog
          title="Example dialog"
          onClose={() => setDialog(false)}
          footer={
            <>
              <Button variant="ghost" neutral onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Close
              </Button>
            </>
          }
        >
          <p>Dialog body.</p>
        </Dialog>
      )}
    </main>
  );
}
