/** The settings registry lives in packages/core so the phone shares it. */
export {
  canAccessSettings,
  canAccessSettingsPage,
  hasPermission,
  parentSettingsPage,
  permissionLabelKeys,
  permissionsOf,
  settingForPath,
  settingsRegistry,
  visibleChildSettings,
  visibleSettings,
  workspacePermissions as permissions,
  type Permission,
  type SettingsEntry,
  type SettingsPageID,
} from "@comamessenger/core";
