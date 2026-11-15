import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
  departmentCount,
  departmentDeletionTargets,
  departmentMoves,
  departmentParentOptions,
  departmentPath,
  foldOrgText,
  orgIndex,
  peopleWithoutDepartment,
  personOrgLine,
  positionPeople,
  type ActorSummary,
  type MessengerAPI,
  type OrgDepartment,
  type OrgStructure,
  type User,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  CheckMark,
  Dialog,
  EmptyState,
  Field,
  FloatingPopover,
  FormError,
  IconButton,
  Menu,
  MenuItem,
  SearchField,
  SelectField,
  Skeleton,
  Switch,
  Tabs,
  cx,
} from "../../../ui";
import { useToast } from "../../../shell/ToastProvider";
import { DepartmentIcon, OrgMark } from "../../../org/DepartmentIcon";
import {
  orgErrorText,
  takeOrgEditor,
  useActorMap,
  useAllActors,
  useOrgAvailable,
  useOrgRefresh,
  useOrgStructure,
  useServerFeatures,
} from "../../../org/useOrg";
import { SettingsAccessDenied } from "../../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../../components/SettingsShell";
import { canAccessSettingsPage } from "../../registry";

type Tab = "departments" | "positions" | "unassigned";
/** The right pane: a department, the «+ Отдел» form or nothing yet. */
type Selection = { kind: "department"; id: string } | { kind: "new" } | null;

/** assignPeopleOrg takes at most 200 people per call. */
const assignBatch = 200;

/**
 * «Настройки → Пространство → Оргструктура» (prototype tab E): departments
 * as a tree with an editor on the right, positions with the hint «Должности
 * из подписей профилей», and people without a department with mass
 * assignment. For org.manage or members.manage.
 */
export function WorkspaceOrgPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const features = useServerFeatures();
  const available = useOrgAvailable();
  const allowed = canAccessSettingsPage(user, "workspace-org", features);
  const org = useOrgStructure(api, allowed);
  const everyone = useAllActors(api, allowed && available);
  const actors = useActorMap(everyone.data);
  const [tab, setTab] = useState<Tab>("departments");
  const [selection, setSelection] = useState<Selection>(() => {
    const pending = takeOrgEditor();
    return pending ? { kind: "department", id: pending } : null;
  });
  const people = useMemo(
    () => (everyone.data ?? []).filter((actor) => actor.type === "user"),
    [everyone.data],
  );
  const structure = org.data;
  const unassigned = structure ? peopleWithoutDepartment(people, structure) : [];

  return (
    <SettingsShell
      user={user}
      active="workspace-org"
      title={t("orgStructure")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : org.isError || everyone.isError ? (
        <div className="settings-page__body">
          <FormError message={orgErrorText(org.error ?? everyone.error)} />
          <Button
            onClick={() => {
              void org.refetch();
              void everyone.refetch();
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : !structure || !everyone.data ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body org-settings">
          <Tabs<Tab>
            underline
            label={t("orgStructure")}
            value={tab}
            onChange={setTab}
            items={[
              { id: "departments", label: t("orgTabDepartments") },
              { id: "positions", label: t("orgTabPositions") },
              {
                id: "unassigned",
                label: t("orgTabUnassigned", { count: unassigned.length }),
              },
            ]}
          />
          {tab === "departments" ? (
            <DepartmentsTab
              api={api}
              structure={structure}
              people={people}
              actors={actors}
              selection={selection}
              onSelect={setSelection}
            />
          ) : tab === "positions" ? (
            <PositionsTab api={api} structure={structure} />
          ) : (
            <UnassignedTab
              api={api}
              structure={structure}
              people={unassigned}
            />
          )}
          <p className="org-hint">{t("orgAdditionalFootnote")}</p>
        </div>
      )}
    </SettingsShell>
  );
}

/* ---------- Shared ---------- */

/** Runs one write: a toast on success, the error text on failure, re-read. */
function useOrgAction() {
  const { toast } = useToast();
  const refresh = useOrgRefresh();
  const [pending, setPending] = useState(false);
  async function run(action: () => Promise<unknown>, done?: string) {
    if (pending) return false;
    setPending(true);
    try {
      await action();
      if (done) toast({ message: done });
      return true;
    } catch (cause) {
      toast({ message: orgErrorText(cause), tone: "danger" });
      return false;
    } finally {
      setPending(false);
      void refresh();
    }
  }
  return { pending, run };
}

async function assignInBatches(
  api: MessengerAPI,
  actorIDs: readonly string[],
  fields: {
    primary_department_id?: string;
    add_department_id?: string;
    position_id?: string | null;
  },
) {
  for (let at = 0; at < actorIDs.length; at += assignBatch)
    await api.assignPeopleOrg({
      actor_ids: actorIDs.slice(at, at + assignBatch),
      ...fields,
    });
}

/** Options for a SelectField: it reads only direct <option> children. */
function departmentOptions(structure: OrgStructure) {
  return orgIndex(structure).order.map((department) => (
    <option key={department.id} value={department.id}>
      {departmentPath(structure, department.id)}
    </option>
  ));
}

function PersonCheckRow({
  actor,
  checked,
  onToggle,
  caption,
  extra,
}: {
  actor: ActorSummary;
  checked: boolean;
  onToggle(): void;
  caption?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className={cx("org-person-row", checked && "org-person-row--checked")}>
      <label className="org-person-row__pick">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <CheckMark checked={checked} />
        <Avatar
          name={actor.display_name}
          seed={actor.actor_id}
          actorID={actor.actor_id}
          avatarVersion={actor.avatar_version}
          size="sm"
        />
        <span className="org-person-row__body">
          <strong className="truncate">{actor.display_name}</strong>
          {caption && <small className="truncate">{caption}</small>}
        </span>
      </label>
      {extra}
    </div>
  );
}

/** «Назначить отдел» / «Назначить должность» for the checked people. */
function MassAssignBar({
  api,
  structure,
  selected,
  onDone,
  allowMove = true,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
  selected: readonly string[];
  onDone(): void;
  allowMove?: boolean;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const [department, setDepartment] = useState("");
  const [position, setPosition] = useState("");
  if (!selected.length) return null;
  return (
    <div className="org-mass" role="region" aria-label={t("orgMassTitle")}>
      <strong>{t("orgSelected", { count: selected.length })}</strong>
      {allowMove && (
        <span className="org-mass__group">
          <SelectField
            label={t("orgAssignDepartment")}
            hideLabel
            name="org-mass-department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value="">{t("orgChooseDepartment")}</option>
            {departmentOptions(structure)}
          </SelectField>
          <Button
            size="sm"
            disabled={!department || pending}
            onClick={() =>
              void run(
                () =>
                  assignInBatches(api, selected, {
                    primary_department_id: department,
                  }),
                t("orgAssigned", { count: selected.length }),
              ).then((ok) => ok && onDone())
            }
          >
            {t("orgAssignDepartment")}
          </Button>
        </span>
      )}
      <span className="org-mass__group">
        <SelectField
          label={t("orgAssignPosition")}
          hideLabel
          name="org-mass-position"
          value={position}
          onChange={(event) => setPosition(event.target.value)}
        >
          <option value="">{t("orgChoosePosition")}</option>
          <option value="none">{t("orgNoPosition")}</option>
          {orgIndex(structure).positionOrder.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </SelectField>
        <Button
          size="sm"
          disabled={!position || pending}
          onClick={() =>
            void run(
              () =>
                assignInBatches(api, selected, {
                  position_id: position === "none" ? null : position,
                }),
              t("orgAssigned", { count: selected.length }),
            ).then((ok) => ok && onDone())
          }
        >
          {t("orgAssignPosition")}
        </Button>
      </span>
    </div>
  );
}

function toggleIn(list: readonly string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/* ---------- Departments ---------- */

function DepartmentsTab({
  api,
  structure,
  people,
  actors,
  selection,
  onSelect,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
  people: readonly ActorSummary[];
  actors: ReadonlyMap<string, ActorSummary>;
  selection: Selection;
  onSelect(selection: Selection): void;
}) {
  const { t } = useTranslation();
  const index = orgIndex(structure);
  // Nothing chosen yet: the first department, so the editor is not empty.
  const selected =
    selection?.kind === "department"
      ? index.departments.get(selection.id)
      : selection === null
        ? index.order[0]
        : undefined;

  return (
    <div className="org-settings__split">
      <section className="org-settings__tree" aria-label={t("orgTabDepartments")}>
        {index.order.length ? (
          <ul className="org-settings__list">
            {index.order.map((department) => {
              const lead = department.lead_actor_id
                ? actors.get(department.lead_actor_id)
                : undefined;
              return (
                <li key={department.id}>
                  <button
                    type="button"
                    className={cx(
                      "org-settings__item",
                      selected?.id === department.id &&
                        "org-settings__item--selected",
                    )}
                    aria-current={selected?.id === department.id ? "true" : undefined}
                    style={{
                      paddingInlineStart: `${(index.depth.get(department.id) ?? 0) * 18 + 10}px`,
                    }}
                    onClick={() =>
                      onSelect({ kind: "department", id: department.id })
                    }
                  >
                    <DepartmentIcon size="sm" />
                    <span className="org-settings__item-body">
                      <strong className="truncate">{department.name}</strong>
                      <small className="truncate">
                        {[
                          lead?.display_name ?? t("orgNoLead"),
                          t("orgPeopleShort", {
                            count: departmentCount(structure, department.id),
                          }),
                        ].join(" · ")}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={<DepartmentIcon size="lg" />}
            title={t("orgEmptyTitle")}
            hint={t("orgEmptyHint")}
          />
        )}
        <Button
          className="org-settings__add"
          onClick={() => onSelect({ kind: "new" })}
        >
          <Plus aria-hidden="true" />
          {t("orgAddDepartment")}
        </Button>
      </section>
      <section className="org-settings__editor">
        {selection?.kind === "new" ? (
          <NewDepartmentForm
            api={api}
            structure={structure}
            people={people}
            defaultParent={undefined}
            onCreated={(id) => onSelect({ kind: "department", id })}
            onCancel={() => onSelect(null)}
          />
        ) : selected ? (
          <DepartmentEditor
            key={`${selected.id}:${selected.version}`}
            api={api}
            department={selected}
            structure={structure}
            people={people}
            actors={actors}
            onDeleted={() => onSelect(null)}
          />
        ) : (
          <EmptyState
            icon={<DepartmentIcon size="lg" />}
            title={t("orgPickDepartment")}
            hint={t("orgPickDepartmentHint")}
          />
        )}
      </section>
    </div>
  );
}

function NewDepartmentForm({
  api,
  structure,
  people,
  defaultParent,
  onCreated,
  onCancel,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
  people: readonly ActorSummary[];
  defaultParent?: string;
  onCreated(id: string): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(defaultParent ?? "");
  const [members, setMembers] = useState<string[]>([]);
  const [primary, setPrimary] = useState(true);
  const [lead, setLead] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const index = orgIndex(structure);
  const byID = new Map(people.map((person) => [person.actor_id, person]));
  const visible = people.filter((person) =>
    foldOrgText(person.display_name).includes(foldOrgText(query)),
  );

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("orgNameRequired"));
      return;
    }
    setError("");
    let created = "";
    const ok = await run(async () => {
      const result = await api.createDepartment({
        name: trimmed,
        ...(parent ? { parent_id: parent } : {}),
        ...(lead && members.includes(lead) ? { lead_actor_id: lead } : {}),
        ...(members.length
          ? {
              members: members.map((actor_id) => ({ actor_id, primary })),
            }
          : {}),
      });
      created = result.department.id;
    }, t("orgDepartmentCreated", { name: trimmed }));
    if (ok && created) onCreated(created);
  }

  return (
    <div className="org-editor">
      <header className="org-editor__head">
        <DepartmentIcon size="lg" />
        <h2>{t("orgNewDepartment")}</h2>
      </header>
      <Field
        label={t("orgDepartmentName")}
        name="org-new-name"
        value={name}
        maxLength={60}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <SelectField
        label={t("orgPartOfField")}
        name="org-new-parent"
        value={parent}
        onChange={(event) => setParent(event.target.value)}
      >
        <option value="">{t("orgTopLevel")}</option>
        {departmentOptions(structure)}
      </SelectField>
      <fieldset className="org-editor__people">
        <legend>{t("orgMembersField")}</legend>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("orgFindPerson")}
          clearLabel={t("clearSearch")}
        />
        <div className="org-check-list org-check-list--people">
          {visible.map((person) => {
            const current = index.people.get(person.actor_id);
            const where = current?.primary_department_id
              ? index.departments.get(current.primary_department_id)?.name
              : t("orgNoDepartment");
            return (
              <PersonCheckRow
                key={person.actor_id}
                actor={person}
                checked={members.includes(person.actor_id)}
                caption={where}
                onToggle={() => {
                  const next = toggleIn(members, person.actor_id);
                  setMembers(next);
                  if (!next.includes(lead)) setLead("");
                }}
              />
            );
          })}
        </div>
        <label className="org-switch">
          <Switch checked={primary} onChange={setPrimary} label={t("orgPrimaryToggle")} />
          <span>
            <strong>{t("orgPrimaryToggle")}</strong>
            <small>
              {primary ? t("orgPrimaryToggleOn") : t("orgPrimaryToggleOff")}
            </small>
          </span>
        </label>
      </fieldset>
      <SelectField
        label={t("orgLead")}
        name="org-new-lead"
        value={lead}
        disabled={!members.length}
        onChange={(event) => setLead(event.target.value)}
      >
        <option value="">
          {members.length ? t("orgNoLead") : t("orgLeadNeedsMembers")}
        </option>
        {members.map((id) => (
          <option key={id} value={id}>
            {byID.get(id)?.display_name ?? id}
          </option>
        ))}
      </SelectField>
      {error && <FormError message={error} />}
      <div className="org-editor__actions">
        <Button onClick={onCancel}>{t("cancel")}</Button>
        <Button variant="primary" pending={pending} onClick={() => void create()}>
          {t("orgCreateDepartment")}
        </Button>
      </div>
    </div>
  );
}

function DepartmentEditor({
  api,
  department,
  structure,
  people,
  actors,
  onDeleted,
}: {
  api: MessengerAPI;
  department: OrgDepartment;
  structure: OrgStructure;
  people: readonly ActorSummary[];
  actors: ReadonlyMap<string, ActorSummary>;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const index = orgIndex(structure);
  const [name, setName] = useState(department.name);
  const [parent, setParent] = useState(department.parent_id ?? "");
  const [lead, setLead] = useState(department.lead_actor_id ?? "");
  const [checked, setChecked] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const members = (index.members.get(department.id) ?? []).filter(
    (membership) => actors.has(membership.actorID),
  );
  const memberIDs = new Set(members.map((membership) => membership.actorID));
  const moves = departmentMoves(structure, department.id);
  const parentOptions = departmentParentOptions(structure, department.id);
  const dirty =
    name.trim() !== department.name ||
    parent !== (department.parent_id ?? "") ||
    lead !== (department.lead_actor_id ?? "");

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(
      () =>
        api.updateDepartment(department.id, {
          expected_version: department.version,
          ...(trimmed !== department.name ? { name: trimmed } : {}),
          ...(parent !== (department.parent_id ?? "")
            ? { parent_id: parent || null }
            : {}),
          ...(lead !== (department.lead_actor_id ?? "")
            ? { lead_actor_id: lead || null }
            : {}),
        }),
      t("changesSaved"),
    );
  }

  return (
    <div className="org-editor">
      <header className="org-editor__head">
        <DepartmentIcon size="lg" />
        <div className="org-editor__title">
          <h2 className="truncate">{department.name}</h2>
          <small className="truncate">
            {[
              departmentPath(structure, department.id, { includeSelf: false }) ||
                t("orgTopLevel"),
              t("orgPeopleShort", {
                count: departmentCount(structure, department.id),
              }),
            ].join(" · ")}
          </small>
        </div>
        <IconButton
          ref={menuAnchor}
          label={t("orgDepartmentMenu")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal />
        </IconButton>
      </header>
      <Field
        label={t("orgDepartmentName")}
        name="org-name"
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
      />
      <SelectField
        label={t("orgPartOfField")}
        name="org-parent"
        value={parent}
        onChange={(event) => setParent(event.target.value)}
      >
        <option value="">{t("orgTopLevel")}</option>
        {parentOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {departmentPath(structure, option.id)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("orgLead")}
        name="org-lead"
        value={lead}
        onChange={(event) => setLead(event.target.value)}
      >
        <option value="">{t("orgNoLead")}</option>
        {members.map((membership) => (
          <option key={membership.actorID} value={membership.actorID}>
            {actors.get(membership.actorID)?.display_name}
          </option>
        ))}
        {people
          .filter((person) => !memberIDs.has(person.actor_id))
          .map((person) => (
            <option key={person.actor_id} value={person.actor_id}>
              {t("orgLeadOutside", { name: person.display_name })}
            </option>
          ))}
      </SelectField>
      {lead && !memberIDs.has(lead) && (
        <p className="org-hint">{t("orgLeadJoins")}</p>
      )}
      <div className="org-editor__actions">
        <Button
          variant="primary"
          disabled={!dirty || !name.trim()}
          pending={pending}
          onClick={save}
        >
          {t("save")}
        </Button>
      </div>

      <section className="org-editor__section">
        <header className="org-editor__section-head">
          <h3>{t("orgMembers", { count: members.length })}</h3>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t("orgAddMembers")}
          </Button>
        </header>
        {members.length ? (
          <div className="org-check-list org-check-list--people">
            {members.map((membership) => {
              const actor = actors.get(membership.actorID)!;
              const isLead = department.lead_actor_id === membership.actorID;
              return (
                <PersonCheckRow
                  key={membership.actorID}
                  actor={actor}
                  checked={checked.includes(membership.actorID)}
                  onToggle={() =>
                    setChecked((list) => toggleIn(list, membership.actorID))
                  }
                  caption={
                    <>
                      {isLead && (
                        <OrgMark kind="lead">{t("orgMarkLead")}</OrgMark>
                      )}
                      {!membership.primary && (
                        <OrgMark kind="additional">
                          {t("orgMarkAdditional")}
                        </OrgMark>
                      )}
                      {personOrgLine(actor, structure)}
                    </>
                  }
                  extra={
                    <span className="org-person-row__actions">
                      {!membership.primary && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending}
                          onClick={() =>
                            void run(
                              () =>
                                api.setDepartmentMember(
                                  department.id,
                                  membership.actorID,
                                  { primary: true, keep_previous: true },
                                ),
                              t("changesSaved"),
                            )
                          }
                        >
                          {t("orgMakePrimary")}
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="danger-ghost"
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () =>
                              api.removeDepartmentMember(
                                department.id,
                                membership.actorID,
                              ),
                            t("orgMemberRemoved", {
                              name: actor.display_name,
                            }),
                          )
                        }
                      >
                        {t("orgRemoveMember")}
                      </Button>
                    </span>
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="org-hint">{t("orgMembersEmpty")}</p>
        )}
        <MassAssignBar
          api={api}
          structure={structure}
          selected={checked}
          onDone={() => setChecked([])}
        />
      </section>

      {menuOpen && (
        <FloatingPopover
          anchorRef={menuAnchor}
          placement="bottom-end"
          width={220}
          onDismiss={() => setMenuOpen(false)}
        >
          <Menu label={t("orgDepartmentMenu")}>
            <MenuItem
              icon={<ArrowUp aria-hidden="true" />}
              disabled={!moves.up || pending}
              onClick={() => {
                setMenuOpen(false);
                void run(() => api.moveDepartment(department.id, "up"));
              }}
            >
              {t("orgMoveUp")}
            </MenuItem>
            <MenuItem
              icon={<ArrowDown aria-hidden="true" />}
              disabled={!moves.down || pending}
              onClick={() => {
                setMenuOpen(false);
                void run(() => api.moveDepartment(department.id, "down"));
              }}
            >
              {t("orgMoveDown")}
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => {
                setMenuOpen(false);
                setDeleting(true);
              }}
            >
              {t("orgDeleteDepartment")}
            </MenuItem>
          </Menu>
        </FloatingPopover>
      )}
      {deleting && (
        <DeleteDepartmentDialog
          api={api}
          department={department}
          structure={structure}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
      {adding && (
        <AddMembersDialog
          api={api}
          department={department}
          structure={structure}
          people={people.filter((person) => !memberIDs.has(person.actor_id))}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function AddMembersDialog({
  api,
  department,
  structure,
  people,
  onClose,
}: {
  api: MessengerAPI;
  department: OrgDepartment;
  structure: OrgStructure;
  people: readonly ActorSummary[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const [picked, setPicked] = useState<string[]>([]);
  const [primary, setPrimary] = useState(true);
  const [query, setQuery] = useState("");
  const index = orgIndex(structure);
  const visible = people.filter((person) =>
    foldOrgText(person.display_name).includes(foldOrgText(query)),
  );
  return (
    <Dialog
      title={t("orgAddMembersTitle", { name: department.name })}
      onClose={onClose}
      sheet
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={!picked.length}
            pending={pending}
            onClick={() =>
              void run(
                () =>
                  assignInBatches(
                    api,
                    picked,
                    primary
                      ? { primary_department_id: department.id }
                      : { add_department_id: department.id },
                  ),
                t("orgAssigned", { count: picked.length }),
              ).then((ok) => ok && onClose())
            }
          >
            {t("orgAddSelected", { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className="org-picker">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("orgFindPerson")}
          clearLabel={t("clearSearch")}
        />
        <div className="org-check-list org-check-list--people">
          {visible.map((person) => {
            const current = index.people.get(person.actor_id);
            return (
              <PersonCheckRow
                key={person.actor_id}
                actor={person}
                checked={picked.includes(person.actor_id)}
                onToggle={() =>
                  setPicked((list) => toggleIn(list, person.actor_id))
                }
                caption={
                  current?.primary_department_id
                    ? index.departments.get(current.primary_department_id)?.name
                    : t("orgNoDepartment")
                }
              />
            );
          })}
          {!visible.length && <p className="org-hint">{t("membersEmpty")}</p>}
        </div>
        <label className="org-switch">
          <Switch checked={primary} onChange={setPrimary} label={t("orgPrimaryToggle")} />
          <span>
            <strong>{t("orgPrimaryToggle")}</strong>
            <small>
              {primary ? t("orgPrimaryToggleOn") : t("orgPrimaryToggleOff")}
            </small>
          </span>
        </label>
      </div>
    </Dialog>
  );
}

function DeleteDepartmentDialog({
  api,
  department,
  structure,
  onClose,
  onDeleted,
}: {
  api: MessengerAPI;
  department: OrgDepartment;
  structure: OrgStructure;
  onClose(): void;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const targets = departmentDeletionTargets(structure, department.id);
  const [target, setTarget] = useState(targets.defaultTarget);
  const index = orgIndex(structure);
  const parent = department.parent_id
    ? index.departments.get(department.parent_id)
    : undefined;
  const children = index.children.get(department.id) ?? [];
  const primaryCount = (index.members.get(department.id) ?? []).filter(
    (membership) => membership.primary,
  ).length;
  return (
    <Dialog
      title={t("orgDeleteTitle", { name: department.name })}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="danger"
            pending={pending}
            onClick={() =>
              void run(
                () => api.deleteDepartment(department.id, target),
                t("orgDepartmentDeleted", { name: department.name }),
              ).then((ok) => {
                if (!ok) return;
                onClose();
                onDeleted();
              })
            }
          >
            {t("orgDeleteConfirm")}
          </Button>
        </>
      }
    >
      <div className="org-delete">
        {primaryCount > 0 && (
          <SelectField
            label={t("orgDeleteMoveTo", { count: primaryCount })}
            name="org-delete-target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="none">{t("orgNoDepartment")}</option>
            {targets.options.map((option) => (
              <option key={option.id} value={option.id}>
                {departmentPath(structure, option.id)}
              </option>
            ))}
          </SelectField>
        )}
        <ul className="org-delete__facts">
          {children.length > 0 && (
            <li>
              {parent
                ? t("orgDeleteChildrenTo", {
                    count: children.length,
                    name: parent.name,
                  })
                : t("orgDeleteChildrenTop", { count: children.length })}
            </li>
          )}
          {primaryCount > 0 && target === "none" && (
            <li>{t("orgDeleteNoneHint")}</li>
          )}
          <li>{t("orgDeleteAdditional")}</li>
          {department.has_chat && <li>{t("orgDeleteChat")}</li>}
        </ul>
      </div>
    </Dialog>
  );
}

/* ---------- Positions ---------- */

function PositionsTab({
  api,
  structure,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const positions = orgIndex(structure).positionOrder;
  const deletingPosition = positions.find((item) => item.id === deleting);

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(() => api.createPosition(trimmed), t("orgPositionCreated")).then(
      (ok) => ok && setName(""),
    );
  }

  return (
    <div className="org-positions">
      <form
        className="org-positions__add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field
          label={t("orgNewPosition")}
          name="org-position-name"
          value={name}
          maxLength={60}
          placeholder={t("orgNewPositionPlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={!name.trim()} pending={pending}>
          <Plus aria-hidden="true" />
          {t("orgAddPosition")}
        </Button>
      </form>
      {positions.length ? (
        <ul className="org-positions__list">
          {positions.map((position) => {
            const count = positionPeople(structure, position.id).length;
            const isEditing = editing?.id === position.id;
            return (
              <li key={position.id} className="org-positions__item">
                {isEditing ? (
                  <form
                    className="org-positions__rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const trimmed = editing.name.trim();
                      if (!trimmed) return;
                      void run(
                        () =>
                          api.updatePosition(position.id, {
                            name: trimmed,
                            expected_version: position.version,
                          }),
                        t("changesSaved"),
                      ).then((ok) => ok && setEditing(null));
                    }}
                  >
                    <Field
                      label={t("orgRenamePosition")}
                      className="org-field--bare"
                      required={false}
                      name="org-position-rename"
                      value={editing.name}
                      maxLength={60}
                      autoFocus
                      onChange={(event) =>
                        setEditing({ id: position.id, name: event.target.value })
                      }
                    />
                    <Button type="submit" size="sm" variant="primary" pending={pending}>
                      {t("save")}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(null)}>
                      {t("cancel")}
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="org-positions__body">
                      <strong>{position.name}</strong>
                      <small>{t("orgPeopleShort", { count })}</small>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEditing({ id: position.id, name: position.name })
                      }
                    >
                      {t("orgRenamePosition")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => setDeleting(position.id)}
                    >
                      {t("orgDelete")}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="org-hint">{t("orgPositionsEmpty")}</p>
      )}
      <TitleSuggestions api={api} structure={structure} />
      {deletingPosition && (
        <Dialog
          title={t("orgDeletePositionTitle", { name: deletingPosition.name })}
          onClose={() => setDeleting(null)}
          size="sm"
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{t("cancel")}</Button>
              <Button
                variant="danger"
                pending={pending}
                onClick={() =>
                  void run(
                    () => api.deletePosition(deletingPosition.id),
                    t("orgPositionDeleted"),
                  ).then(() => setDeleting(null))
                }
              >
                {t("orgDelete")}
              </Button>
            </>
          }
        >
          <p>
            {t("orgDeletePositionHint", {
              count: positionPeople(structure, deletingPosition.id).length,
            })}
          </p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * «Должности из подписей профилей»: the free captions people wrote
 * (`title`) that are not positions yet. Checked ones become positions, and
 * optionally the people with that caption get the position.
 */
function TitleSuggestions({
  api,
  structure,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
}) {
  const { t } = useTranslation();
  const { pending, run } = useOrgAction();
  const suggestions = useQuery({
    queryKey: ["org", "title-suggestions", structure.version],
    queryFn: () => api.titleSuggestions(),
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [assign, setAssign] = useState(true);
  const list = suggestions.data ?? [];
  if (suggestions.isLoading || !list.length) return null;

  function create() {
    const chosen = list.filter((item) => picked.includes(item.title));
    void run(async () => {
      const result = await api.createPositions(chosen.map((item) => item.title));
      if (!assign) return;
      const known = new Map(
        [...result.created, ...orgIndex(structure).positionOrder].map(
          (position) => [foldOrgText(position.name), position.id],
        ),
      );
      for (const item of chosen) {
        const positionID = known.get(foldOrgText(item.title));
        if (positionID && item.actor_ids.length)
          await assignInBatches(api, item.actor_ids, {
            position_id: positionID,
          });
      }
    }, t("orgPositionsCreated", { count: chosen.length })).then(
      (ok) => ok && setPicked([]),
    );
  }

  return (
    <section className="org-suggestions" aria-label={t("orgSuggestionsTitle")}>
      <header>
        <h3>{t("orgSuggestionsTitle")}</h3>
        <p className="org-hint">{t("orgSuggestionsHint")}</p>
      </header>
      <div className="org-check-list">
        {list.map((item) => {
          const checked = picked.includes(item.title);
          return (
            <label key={item.title} className="org-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => setPicked((value) => toggleIn(value, item.title))}
              />
              <CheckMark checked={checked} />
              <span className="truncate">{item.title}</span>
              <small>{t("orgPeopleShort", { count: item.count })}</small>
            </label>
          );
        })}
      </div>
      <label className="org-switch">
        <Switch checked={assign} onChange={setAssign} label={t("orgSuggestionsAssign")} />
        <span>
          <strong>{t("orgSuggestionsAssign")}</strong>
        </span>
      </label>
      <Button
        disabled={!picked.length}
        pending={pending}
        onClick={create}
      >
        {t("orgSuggestionsCreate", { count: picked.length })}
      </Button>
    </section>
  );
}

/* ---------- Without a department ---------- */

function UnassignedTab({
  api,
  structure,
  people,
}: {
  api: MessengerAPI;
  structure: OrgStructure;
  people: readonly ActorSummary[];
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState<string[]>([]);
  const present = checked.filter((id) =>
    people.some((person) => person.actor_id === id),
  );
  const all = people.length > 0 && present.length === people.length;
  if (!people.length)
    return (
      <EmptyState
        icon={<DepartmentIcon size="lg" />}
        title={t("orgUnassignedEmpty")}
        hint={t("orgUnassignedEmptyHint")}
      />
    );
  return (
    <div className="org-unassigned">
      <label className="org-check org-check--all">
        <input
          type="checkbox"
          checked={all}
          onChange={() =>
            setChecked(all ? [] : people.map((person) => person.actor_id))
          }
        />
        <CheckMark checked={all} />
        <span>{t("orgSelectAll", { count: people.length })}</span>
      </label>
      <div className="org-check-list org-check-list--people">
        {people.map((person) => (
          <PersonCheckRow
            key={person.actor_id}
            actor={person}
            checked={present.includes(person.actor_id)}
            caption={personOrgLine(person, structure)}
            onToggle={() =>
              setChecked((list) => toggleIn(list, person.actor_id))
            }
          />
        ))}
      </div>
      <MassAssignBar
        api={api}
        structure={structure}
        selected={present}
        onDone={() => setChecked([])}
      />
    </div>
  );
}
