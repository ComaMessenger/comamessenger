# Настройки пространства: участники и доступ

Маршрут `/settings/workspace/members`, permission `members.manage`.

## Список

SettingsSection с rows: avatar, имя/handle, last seen, badges роли owner/admin/member и active/deactivated, action «Управлять». Loading/error/empty обязательны.

## Управление участником

Dialog: identity; Role select (owner доступен только корректному owner-flow); Activate/Deactivate; Change/Remove avatar с validation; Require password change; Send password reset при доступной почте; для admin — fieldset granular permissions со всеми workspace/agent/audit/moderation capabilities. Save/pending/success/error.

## Передача владения

Отдельная danger-sensitive section только владельцу: New owner select, Current password, explicit confirm. Объяснить необратимое изменение собственной роли; pending защищает от дубля.

На mobile member row остаётся grid без наложений, dialog fullscreen/scrollable, permission switches одной колонкой. Нельзя деактивировать/понизить последнего owner без ясной ошибки.
