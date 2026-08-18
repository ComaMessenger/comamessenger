# ADR-0004: организация, репозиторий и Go module path

- Статус: принято
- Дата: 2026-08-18

## Решение

- GitHub organization: `ComaMessenger`.
- Основной репозиторий: `ComaMessenger/comamessenger`.
- Канонические URL и module paths записываются в нижнем регистре.
- Go module внутри каталога `core/`: `github.com/comamessenger/comamessenger/core`.
- Основная ветка: `main`.

## Последствия

- Публичные импорты Go совпадают с расположением `core/go.mod`.
- Перенос или переименование репозитория после первых публичных релизов считается breaking operational change и требует migration guide.
