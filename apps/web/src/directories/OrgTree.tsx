import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  buildOrgTree,
  departmentAncestors,
  departmentPeople,
  flattenOrgTree,
  orgIndex,
  orgNameMatches,
  type ActorSummary,
  type OrgStructure,
  type OrgTreeRow,
} from "@comamessenger/core";
import { Avatar, cx } from "../ui";

const collapsedKey = "coma-org-tree-collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(collapsedKey);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(value: ReadonlySet<string>) {
  try {
    localStorage.setItem(collapsedKey, JSON.stringify([...value]));
  } catch {
    // Private mode: the tree just opens expanded next time.
  }
}

/**
 * The org tree (prototype tab D): indent and a guide line for nesting, the
 * lead under the name, the head count with subdepartments on the right. A
 * WAI-ARIA tree: arrows move and fold, Enter opens the department card.
 * Folded branches are remembered in this browser.
 */
export function OrgTree({
  structure,
  actors,
  selectedID,
  query = "",
  onOpen,
  label,
}: {
  structure: OrgStructure;
  actors: ReadonlyMap<string, ActorSummary>;
  selectedID?: string;
  /** Departments whose name, lead or people match; their parents stay. */
  query?: string;
  onOpen(departmentID: string): void;
  label: string;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildOrgTree(structure), [structure]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const searching = query.trim().length > 0;

  const rows = useMemo<OrgTreeRow[]>(() => {
    if (!searching) {
      const index = orgIndex(structure);
      const expanded = new Set(
        index.order
          .map((department) => department.id)
          .filter((id) => !collapsed.has(id)),
      );
      return flattenOrgTree(tree, expanded);
    }
    const index = orgIndex(structure);
    const visible = new Set<string>();
    for (const department of index.order) {
      const lead = department.lead_actor_id
        ? actors.get(department.lead_actor_id)?.display_name ?? ""
        : "";
      const people = departmentPeople(structure, department.id, {
        nested: false,
      }).map((id) => actors.get(id)?.display_name ?? "");
      if (
        orgNameMatches(department.name, query) ||
        (lead && orgNameMatches(lead, query)) ||
        people.some((name) => name && orgNameMatches(name, query))
      ) {
        visible.add(department.id);
        for (const parent of departmentAncestors(structure, department.id))
          visible.add(parent.id);
      }
    }
    return flattenOrgTree(tree, "all").filter((row) =>
      visible.has(row.node.department.id),
    );
  }, [actors, collapsed, query, searching, structure, tree]);

  const [focusedID, setFocusedID] = useState<string | null>(null);
  const focused =
    rows.find((row) => row.node.department.id === focusedID) ??
    rows.find((row) => row.node.department.id === selectedID) ??
    rows[0];
  const items = useRef(new Map<string, HTMLDivElement>());
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current || !focused) return;
    moveFocus.current = false;
    items.current.get(focused.node.department.id)?.focus();
  }, [focused]);

  function toggle(id: string, open?: boolean) {
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldOpen = open ?? next.has(id);
      if (shouldOpen) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });
  }

  function focusRow(row: OrgTreeRow | undefined) {
    if (!row) return;
    moveFocus.current = true;
    setFocusedID(row.node.department.id);
  }

  function keys(event: KeyboardEvent<HTMLDivElement>, row: OrgTreeRow) {
    const at = rows.indexOf(row);
    const id = row.node.department.id;
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[at + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[at - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (row.hasChildren && !row.expanded && !searching) toggle(id, true);
        else if (row.expanded) focusRow(rows[at + 1]);
        break;
      case "ArrowLeft": {
        if (row.expanded && !searching) {
          toggle(id, false);
          break;
        }
        const parent = row.node.department.parent_id;
        focusRow(rows.find((item) => item.node.department.id === parent));
        break;
      }
      case "Enter":
      case " ":
        onOpen(id);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  if (!rows.length)
    return <p className="org-tree__empty">{t("orgTreeNothingFound")}</p>;

  return (
    <div className="org-tree" role="tree" aria-label={label}>
      {rows.map((row) => {
        const department = row.node.department;
        const lead = department.lead_actor_id
          ? actors.get(department.lead_actor_id)
          : undefined;
        const isFocused = focused?.node.department.id === department.id;
        return (
          <div
            key={department.id}
            ref={(element) => {
              if (element) items.current.set(department.id, element);
              else items.current.delete(department.id);
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={
              row.hasChildren && !searching ? row.expanded : undefined
            }
            aria-selected={department.id === selectedID}
            aria-label={t("orgTreeItemLabel", {
              name: department.name,
              count: row.node.count,
            })}
            tabIndex={isFocused ? 0 : -1}
            className={cx(
              "org-tree__row",
              department.id === selectedID && "org-tree__row--selected",
            )}
            style={{ paddingInlineStart: `${row.depth * 18 + 4}px` }}
            onClick={() => {
              setFocusedID(department.id);
              onOpen(department.id);
            }}
            onKeyDown={(event) => keys(event, row)}
          >
            {Array.from({ length: row.depth }, (_, level) => (
              <span
                key={level}
                className="org-tree__guide"
                style={{ insetInlineStart: `${level * 18 + 14}px` }}
                aria-hidden="true"
              />
            ))}
            <span
              className={cx(
                "org-tree__twist",
                row.hasChildren && !row.expanded && "org-tree__twist--closed",
              )}
              aria-hidden="true"
              onClick={(event) => {
                if (!row.hasChildren || searching) return;
                event.stopPropagation();
                toggle(department.id);
              }}
            >
              {row.hasChildren && <ChevronDown />}
            </span>
            <span className="org-tree__body">
              <strong className="truncate">{department.name}</strong>
              <small className="truncate">
                {lead ? (
                  <>
                    <Avatar
                      name={lead.display_name}
                      seed={lead.actor_id}
                      actorID={lead.actor_id}
                      avatarVersion={lead.avatar_version}
                      size="xs"
                    />
                    {lead.display_name}
                  </>
                ) : (
                  t("orgNoLead")
                )}
              </small>
            </span>
            <span className="org-tree__count">{row.node.count}</span>
          </div>
        );
      })}
    </div>
  );
}
