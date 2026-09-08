import { useState } from "react";
import { MessageCircle } from "lucide-react";
import {
  Avatar,
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

/** Internal QA screen at /dev/components: primitives in every state. */
export function ComponentCatalog() {
  const [dialog, setDialog] = useState(false);
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState<"a" | "b">("a");
  const [segment, setSegment] = useState<"all" | "mentions" | "none">("all");
  return (
    <main className="component-catalog">
      <h1>Coma UI</h1>
      <section>
        <h2>Actions</h2>
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
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
        <Button onClick={() => setDialog(true)}>Dialog</Button>
      </section>
      <section>
        <h2>Identity</h2>
        <Avatar name="Sample User" size="lg" online />
        <Avatar name="Coma Assistant" size="lg" agent />
        <Avatar name="Away Person" size="lg" presence="away" />
        <Badge tone="primary">99+</Badge>
        <Badge>3</Badge>
        <Tag tone="agent">agent</Tag>
        <Chip active>Active chip</Chip>
        <Chip dot="green">Folder</Chip>
        <Switch checked={on} onChange={setOn} label="Switch" />
      </section>
      <section>
        <h2>Form</h2>
        <Field label="Text field" name="catalog" placeholder="Long localized content" />
        <Field label="With error" name="catalog-error" error="Something is wrong" />
        <TextareaField label="Message" name="message" />
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
      <section>
        <h2>States</h2>
        <Skeleton width={180} height={38} shape="rect" />
        <FormError message="Example error state" />
        <InlineError title="Could not refresh" hint="Showing saved data" retryLabel="Retry" onRetry={() => undefined} />
        <InlineSuccess title="Saved successfully" />
        <InkCard title="Ink card">Dark surface for greetings and hints.</InkCard>
        <Toast tone="success">Saved successfully</Toast>
        <Toast ink action={<button type="button" className="ui-toast__action">Undo</button>}>
          Message pinned
        </Toast>
        <EmptyState title="Nothing here" hint="Empty state hint" />
        <Popover>Popover content can wrap across lines.</Popover>
        <Menu label="Example menu">
          <MenuItem>Menu item</MenuItem>
          <MenuItem danger>Danger item</MenuItem>
        </Menu>
      </section>
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
