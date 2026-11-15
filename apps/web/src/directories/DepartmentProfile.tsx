import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  MessageSquare,
  MoreHorizontal,
  Pencil,
  UserPlus,
} from "lucide-react";
import {
  canManageDepartmentChat,
  canManageOrg,
  departmentChatState,
  departmentCount,
  departmentPath,
  orgIndex,
  personOrgLine,
  type ActorSummary,
  type OrgStructure,
} from "@comamessenger/core";
import {
  Button,
  EmptyState,
  FloatingPopover,
  IconButton,
  Menu,
  MenuItem,
} from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { DirectoryDetailHead } from "./DirectoryPage";
import { departmentPathOf } from "./routes";
import { DepartmentIcon, OrgMark } from "../org/DepartmentIcon";
import { OrgDepartmentLink, OrgPersonLink } from "../org/OrgRows";
import { LinkDepartmentChatDialog } from "../org/LinkDepartmentChatDialog";
import { openOrgEditor, orgErrorText, useOrgRefresh } from "../org/useOrg";

/**
 * The department card (prototype tab B): lead, "Part of", subdepartments,
 * people with "also", and the department chat — open it, create it, link
 * an existing group or add the people missing from it.
 */
export function DepartmentProfile({
  departmentID,
  structure,
  actors,
  onBack,
  standalone = false,
}: {
  departmentID: string;
  structure: OrgStructure;
  actors: ReadonlyMap<string, ActorSummary>;
  onBack(): void;
  /** Phone / narrow screen: a page with its own back button. */
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const { api, user, navigate, reload } = useMessenger();
  const { toast } = useToast();
  const refresh = useOrgRefresh();
  const index = orgIndex(structure);
  const department = index.departments.get(departmentID);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const chat = department ? departmentChatState(user, department) : null;
  const managesChat = department
    ? canManageDepartmentChat(user, department)
    : false;
  const missing = useQuery({
    queryKey: ["org", "chat-missing", departmentID, department?.chat_id],
    queryFn: () => api.departmentChatMissing(departmentID),
    enabled: chat?.kind === "open" && !chat.archived && managesChat,
  });

  const members = useMemo(
    () =>
      (index.members.get(departmentID) ?? []).filter(
        (membership) =>
          membership.actorID !== department?.lead_actor_id &&
          actors.has(membership.actorID),
      ),
    [actors, department?.lead_actor_id, departmentID, index.members],
  );

  if (!department)
    return (
      <div className="member-profile">
        {standalone && (
          <DirectoryDetailHead onBack={onBack} title={t("orgDepartment")} />
        )}
        <EmptyState
          className="directory-detail__empty"
          icon={<DepartmentIcon size="lg" />}
          title={t("orgDepartmentGone")}
          hint={t("orgDepartmentGoneHint")}
        />
      </div>
    );

  const parent = department.parent_id
    ? index.departments.get(department.parent_id)
    : undefined;
  const children = index.children.get(department.id) ?? [];
  const path = departmentPath(structure, department.id, { includeSelf: false });
  const count = departmentCount(structure, department.id);
  const lead = department.lead_actor_id
    ? actors.get(department.lead_actor_id)
    : undefined;
  const missingCount = missing.data?.length ?? 0;

  async function run(action: () => Promise<unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (done) toast({ message: done });
    } catch (cause) {
      toast({ message: orgErrorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  function createChat() {
    void run(async () => {
      const result = await api.createDepartmentChat(department!.id);
      await reload();
      navigate(`/chat/${result.chat.id}`);
    });
  }

  function addMissing() {
    void run(async () => {
      const added = await api.addDepartmentChatMissing(department!.id);
      await missing.refetch();
      toast({ message: t("orgChatAdded", { count: added }) });
    });
  }

  const openPerson = (actorID: string) => navigate(`/members/${actorID}`);
  const openDepartment = (id: string) => navigate(departmentPathOf(id));

  return (
    <div className="member-profile org-card">
      {standalone && (
        <DirectoryDetailHead onBack={onBack} title={t("orgDepartment")} />
      )}
      <div className="member-profile__scroll">
        <header className="member-profile__identity">
          <DepartmentIcon size="xl" />
          <div className="member-profile__copy">
            <div className="member-profile__name">
              <h2>{department.name}</h2>
            </div>
            <p className="member-profile__handle">
              {[path, t("orgPeopleCount", { count })]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="member-profile__actions">
              {chat?.kind === "open" && (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => navigate(`/chat/${chat.chatID}`)}
                >
                  <MessageSquare aria-hidden="true" />
                  {t("orgChatOpen")}
                </Button>
              )}
              {chat?.kind === "create" && (
                <Button
                  variant="primary"
                  size="md"
                  pending={busy}
                  onClick={createChat}
                >
                  <MessageSquare aria-hidden="true" />
                  {t("orgChatCreate")}
                </Button>
              )}
              {canManageOrg(user) && (
                <Button
                  size="md"
                  onClick={() => {
                    openOrgEditor(department.id);
                    navigate("/settings/workspace/org");
                  }}
                >
                  <Pencil aria-hidden="true" />
                  {t("orgEdit")}
                </Button>
              )}
              {managesChat && (
                <IconButton
                  ref={menuAnchor}
                  label={t("orgDepartmentMenu")}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <MoreHorizontal />
                </IconButton>
              )}
            </div>
            {chat?.kind === "notMember" && (
              <p className="org-card__note">
                {chat.archived ? t("orgChatArchived") : t("orgChatNotMember")}
              </p>
            )}
            {chat?.kind === "open" && chat.archived && (
              <p className="org-card__note">{t("orgChatArchived")}</p>
            )}
            {missingCount > 0 && (
              <div className="org-card__missing" role="status">
                <UserPlus aria-hidden="true" />
                <span>{t("orgChatMissing", { count: missingCount })}</span>
                <Button size="sm" pending={busy} onClick={addMissing}>
                  {t("orgChatAddMissing")}
                </Button>
              </div>
            )}
          </div>
        </header>
        <div className="member-profile__cards">
          <section className="member-profile__card">
            <h3>{t("orgLead")}</h3>
            <div className="org-card__list">
              {lead ? (
                <OrgPersonLink
                  actor={lead}
                  caption={personOrgLine(lead, structure)}
                  onClick={() => openPerson(lead.actor_id)}
                />
              ) : (
                <p className="member-profile__muted">{t("orgNoLead")}</p>
              )}
              {parent && (
                <OrgDepartmentLink
                  department={parent}
                  caption={t("orgPartOf")}
                  onClick={() => openDepartment(parent.id)}
                />
              )}
            </div>
          </section>
          {children.length > 0 && (
            <section className="member-profile__card">
              <h3>{t("orgSubdepartments", { count: children.length })}</h3>
              <div className="org-card__list">
                {children.map((child) => {
                  const childLead = child.lead_actor_id
                    ? actors.get(child.lead_actor_id)
                    : undefined;
                  return (
                    <OrgDepartmentLink
                      key={child.id}
                      department={child}
                      caption={[
                        childLead?.display_name ?? t("orgNoLead"),
                        t("orgPeopleShort", {
                          count: departmentCount(structure, child.id),
                        }),
                      ].join(" · ")}
                      onClick={() => openDepartment(child.id)}
                    />
                  );
                })}
              </div>
            </section>
          )}
          {(members.length > 0 || !lead) && (
          <section className="member-profile__card">
              <h3>{t("orgMembers", { count: members.length })}</h3>
              {members.length ? (
                <div className="org-card__list">
                  {members.map((membership) => {
                    const actor = actors.get(membership.actorID)!;
                    return (
                      <OrgPersonLink
                        key={membership.actorID}
                        actor={actor}
                        caption={personOrgLine(actor, structure)}
                        mark={
                          !membership.primary && (
                            <OrgMark kind="additional">
                              {t("orgMarkAdditional")}
                            </OrgMark>
                          )
                        }
                        onClick={() => openPerson(membership.actorID)}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="member-profile__muted">{t("orgMembersEmpty")}</p>
              )}
            </section>
          )}
        </div>
      </div>
      {menuOpen && (
        <FloatingPopover
          anchorRef={menuAnchor}
          placement="bottom-end"
          width={240}
          onDismiss={() => setMenuOpen(false)}
        >
          <Menu label={t("orgDepartmentMenu")}>
            {department.has_chat ? (
              <MenuItem
                danger
                onClick={() => {
                  setMenuOpen(false);
                  void run(
                    () => api.unlinkDepartmentChat(department.id),
                    t("orgChatUnlinked"),
                  );
                }}
              >
                {t("orgChatUnlink")}
              </MenuItem>
            ) : (
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  setLinking(true);
                }}
              >
                {t("orgChatLink")}
              </MenuItem>
            )}
          </Menu>
        </FloatingPopover>
      )}
      {linking && (
        <LinkDepartmentChatDialog
          department={department}
          structure={structure}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            toast({ message: t("orgChatLinked") });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

