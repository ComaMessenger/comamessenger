# Coma protocol package

`@comamessenger/protocol` хранит публичные REST и realtime-контракты Coma.

## Источники истины

- [`openapi.yaml`](openapi.yaml) — REST-схемы, стабильные error codes и ссылки на realtime frames;
- [`schemas/realtime/v1.schema.json`](schemas/realtime/v1.schema.json) — versioned JSON Schema WebSocket-протокола;
- [`fixtures/realtime/v1`](fixtures/realtime/v1) — общие wire fixtures для Go и TypeScript.

Файлы в `src/generated` вручную не редактируются. Команда из корня репозитория:

```sh
make generate
```

собирает внешний JSON Schema reference в детерминированный OpenAPI bundle, генерирует TypeScript-модели и fixtures, затем генерирует Go-модели Core из того же bundle.

## Совместимость

В пределах `v1` разрешено добавлять необязательные поля и новые event types. Удаление поля, изменение discriminator или добавление обязательного поля является breaking change и требует новой версии протокола.

CI повторяет генерацию и требует чистый diff. Go-тест валидирует JSON fixtures исходной схемой и декодирует их сгенерированными Go-типами; TypeScript compiler проверяет те же fixtures через `satisfies`.
