# Агент: автоматизации

Маршрут `/agents/:agentId/automations`.

SettingsSection «Триггеры». Builder видит inline create form: Type select и условное Configuration field, Add. Типы: manual, mention, command, keyword, every message, schedule, event. Для schedule placeholder `09:00`, event — `member.joined`, command показывается с `/`; manual/mention/every-message не требуют value.

Ниже record list. Строка: локализованный type, человекочитаемая конфигурация/hint, enabled/disabled badge, Enable/Disable и Delete. Observer видит список без editing controls.

Предусмотреть empty state, invalid configuration, timezone/missed-run policy в future expansion, pending конкретной строки и inline error. Опасные широкие триггеры `every_message`/event должны иметь ясное impact-пояснение. На mobile create form складывается вертикально.
