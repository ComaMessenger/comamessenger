# Агент: настройки и ключи

Маршрут `/agents/:agentId/settings`, builder-only.

Toolbar: Duplicate; Reset template только для recipe-агента; Delete. Оба destructive/reverting действия открывают отдельное confirmation dialog. Основной SettingsSection «Credentials».

Если назначено workspace LLM connection — security notice, что агент использует его, без secret. Иначе legacy provider API key password field с masked hint и Save. Ниже runtime keys: name, prefix, scopes; revoke icon. CTA Create runtime key. Отдельная workspace worker key карточка/CTA при необходимости.

Новый secret показывается ровно один раз в status block: предупреждение «скопируйте сейчас», monospace code и Copy. После закрытия восстановить его нельзя.

Delete dialog называет агента и требует явного danger action; после успеха возвращает в `/agents`. Reset объясняет, что draft вернётся к recipe defaults. Duplicate создаёт новое имя/handle и открывает копию. Предусмотреть used key, revoke pending, empty keys, copy success, server error и запрет случайного повторного создания.
