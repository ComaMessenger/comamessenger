# Настройки пространства: основные

Маршрут `/settings/workspace/general`, permission `workspace.settings`.

Одна SettingsSection с полями Organization name, Default workspace timezone и Slug. Slug — стабильный технический идентификатор, поэтому нужен hint о допустимых символах/последствиях изменения. Форма автосохраняется либо показывает единый ясный Save state согласно реализации экрана.

После изменения названия/бренда shell обновляется без reload. Состояния: loading, dirty/saving/saved/error, validation slug, duplicate slug, access denied. На mobile поля на всю ширину; timezone labels выдерживают длинные IANA names.
