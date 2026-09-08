import { Check, LogOut, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Menu, MenuDivider, MenuItem } from "../ui";
import { useMessenger } from "./MessengerContext";
import { Logo } from "./Logo";

export function workspaceRoleKey(role: "owner" | "admin" | "member") {
  return role === "owner"
    ? "workspaceOwner"
    : role === "admin"
      ? "workspaceAdmin"
      : "workspaceMember";
}

export function WorkspaceMenu({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { user, navigate, logout } = useMessenger();
  return (
    <Menu label={t("workspaceMenu")} className="workspace-menu">
      <div className="workspace-menu__account">
        <strong className="truncate">{user.email}</strong>
        <span>{t(workspaceRoleKey(user.role))}</span>
      </div>
      <div className="workspace-menu__current" aria-current="true">
        <Logo size="xs" />
        <strong className="truncate">{user.organization_name}</strong>
        <Check aria-hidden="true" />
      </div>
      {user.role !== "member" && (
        <MenuItem
          icon={<Settings />}
          onClick={() => {
            onClose();
            navigate("/settings/workspace");
          }}
        >
          {t("workspaceSettings")}
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem danger icon={<LogOut />} onClick={() => void logout()}>
        {t("logout")}
      </MenuItem>
    </Menu>
  );
}
