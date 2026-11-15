import { Network } from "lucide-react";
import { cx } from "../ui";

/** The square department mark of the prototype: list rows, cards, menus. */
export function DepartmentIcon({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  return (
    <span
      className={cx("org-icon", `org-icon--${size}`, className)}
      aria-hidden="true"
    >
      <Network />
    </span>
  );
}

/** "lead" / "also" after a name. */
export function OrgMark({
  kind,
  children,
}: {
  kind: "lead" | "additional";
  children: string;
}) {
  return <span className={cx("org-mark", `org-mark--${kind}`)}>{children}</span>;
}
