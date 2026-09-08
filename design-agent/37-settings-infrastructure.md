# Настройки: подключения инфраструктуры

Маршрут `/settings/infrastructure`, permission `integrations.manage`.

Это технический admin screen с явной общей кнопкой Save, dirty state и отдельными Test connection. Секреты никогда не раскрываются, только masked hints.

## S3 storage

Endpoint, Region, Bucket, Prefix, Access key, Secret key; Force path style switch с hint; Test connection disabled, пока есть несохранённые изменения. Поля группируются логически, но labels сверху.

## SMTP delivery

Host, Port, Username, Password с masked hint, From address, From name, Security select (TLS/STARTTLS/none), Test connection.

Состояния: loading, dirty, saving, saved, test pending/success/failure, partially configured secret, invalid endpoint/port/email, access denied. Test result остаётся рядом с соответствующей секцией. На mobile form grids в одну колонку, Save может быть sticky, но не перекрывает tab bar.
