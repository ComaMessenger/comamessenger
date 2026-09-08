# Агент: поведение

Маршрут `/agents/:agentId/behavior`, для builder. Toolbar содержит Save; изменения являются draft.

## Основные секции

- Identity: display name, handle, instructions/description, Enabled switch с пояснением.
- Chats: список доступных чатов с checkbox/multi-select — где агент может читать/работать.
- Advanced раскрывается через disclosure и по умолчанию не доминирует.
- Provider: workspace connection select, model, explicit external-data-sharing switch.
- Permissions: grid scopes с человекочитаемыми labels.
- Limits: daily/monthly budget, max output tokens, max tool iterations, per-chat concurrency, per-minute rate, execution timeout.

Readiness card остаётся сверху и мгновенно отражает незаполненные обязательные поля. Save имеет pending/success/error. Нельзя использовать raw scopes/provider internals в основном beginner flow без пояснений. На mobile form grids становятся одной колонкой; advanced groups сохраняют раскрытие и не теряют значения.
