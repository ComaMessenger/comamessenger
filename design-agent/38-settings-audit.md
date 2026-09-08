# Настройки: журнал аудита

Маршрут `/settings/audit`, permission `audit.read`.

SettingsSection «Журнал аудита». Верхняя filter area: Category (all/workspace/members/invitations/chats/branding/connections), Actor, From, To. Filters должны быть компактны на desktop и вертикальны на mobile.

Список событий: category icon, одно естественное предложение («Лев изменил…»), relative/absolute time. Actor/target names приоритетнее технических ID. Раскрытие события показывает changes table: Field / Was / Became; секретные поля заменены безопасными flags. Неизвестный action имеет понятный fallback, а не ломает row.

Pagination Previous/Next по cursor, сохранение filters. Состояния: skeleton, empty по фильтру, network error, system actor, deleted actor/target, event без changes. Время локализовано; длинные значения переносятся или показываются в code style без горизонтального scroll.
