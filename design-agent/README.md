# Coma Messenger — пакет постановки для дизайн-агента

Эта папка описывает фактически реализованные экраны Web-клиента Coma Messenger на 8 сентября 2026 года. Документы собраны по маршрутам и состояниям из `apps/web/src/router.tsx`, `App.tsx`, модуля `settings`, CSS и действующей продуктовой спецификации.

## Как работать с пакетом

1. Начать с [00-product-and-navigation.md](00-product-and-navigation.md) и [01-design-system-brief.md](01-design-system-brief.md).
2. Спроектировать общие оболочки из [02-app-shell.md](02-app-shell.md).
3. Делать экраны по отдельным файлам ниже. Один файл соответствует одному самостоятельному экрану или важному полноэкранному flow.
4. Общие диалоги, popover и меню вынесены в [39-dialogs-and-overlays.md](39-dialogs-and-overlays.md), чтобы не дублировать их на каждом экране.
5. Макеты нужны минимум в desktop 1440×900 и mobile 390×844; дополнительно проверить узкий desktop/tablet 768–840 px, RU/EN, light/dark и длинные пользовательские строки.

## Реестр экранов

### Авторизация

- [03-loading.md](03-loading.md) — загрузка и определение состояния сервера.
- [04-login.md](04-login.md) — вход.
- [05-password-recovery.md](05-password-recovery.md) — запрос ссылки восстановления.
- [06-reset-password.md](06-reset-password.md) — установка нового пароля.
- [07-bootstrap.md](07-bootstrap.md) — первичная настройка пространства.
- [08-invitation.md](08-invitation.md) — принятие приглашения.

### Мессенджер

- [09-chat-list.md](09-chat-list.md) — список и фильтры чатов.
- [10-conversation.md](10-conversation.md) — лента сообщений и composer.
- [11-thread.md](11-thread.md) — отдельный тред.
- [12-threads-directory.md](12-threads-directory.md) — каталог подписанных тредов.
- [13-important.md](13-important.md) — важные/закреплённые сообщения.
- [14-members-directory.md](14-members-directory.md) — каталог участников.
- [15-mobile-more.md](15-mobile-more.md) — мобильный раздел «Ещё».

### Платформа агентов

- [16-agents-catalog.md](16-agents-catalog.md) — каталог агентов.
- [17-agent-creation-wizard.md](17-agent-creation-wizard.md) — пятишаговый мастер.
- [18-agent-connections.md](18-agent-connections.md) — подключения LLM.
- [19-agent-approvals.md](19-agent-approvals.md) — очередь согласований.
- [20-agent-activity-global.md](20-agent-activity-global.md) — общая аналитика.
- [21-agent-overview.md](21-agent-overview.md) — readiness, версии, публикация.
- [22-agent-behavior.md](22-agent-behavior.md) — задача и поведение.
- [23-agent-knowledge.md](23-agent-knowledge.md) — знания (пока placeholder).
- [24-agent-automations.md](24-agent-automations.md) — триггеры.
- [25-agent-test.md](25-agent-test.md) — песочница.
- [26-agent-activity.md](26-agent-activity.md) — запуски выбранного агента.
- [27-agent-settings.md](27-agent-settings.md) — ключи и опасные действия.

### Настройки

- [28-settings-profile.md](28-settings-profile.md)
- [29-settings-notifications.md](29-settings-notifications.md)
- [30-settings-security.md](30-settings-security.md)
- [31-settings-workspace-overview.md](31-settings-workspace-overview.md)
- [32-settings-workspace-general.md](32-settings-workspace-general.md)
- [33-settings-workspace-members.md](33-settings-workspace-members.md)
- [34-settings-workspace-invitations.md](34-settings-workspace-invitations.md)
- [35-settings-workspace-policies.md](35-settings-workspace-policies.md)
- [36-settings-customization.md](36-settings-customization.md)
- [37-settings-infrastructure.md](37-settings-infrastructure.md)
- [38-settings-audit.md](38-settings-audit.md)
- [39-dialogs-and-overlays.md](39-dialogs-and-overlays.md)
- [40-component-catalog.md](40-component-catalog.md) — внутренний QA-экран.

## Важная трактовка

Маршруты `/agents/sandbox` и `/agents/runs` оставлены только для обратной совместимости и визуально открывают каталог агентов. `/m/:messageKey` — технический deep link: он разрешает сообщение и перенаправляет в нужный чат, отдельный экран для него не нужен. Корневой `/` после проверки сессии ведёт в `/chats`.

Существующие эталонные скриншоты находятся в `apps/web/e2e/foundation.spec.ts-snapshots/`; они полезны как фиксация текущего поведения, но новый дизайн не обязан буквально копировать пиксели.
