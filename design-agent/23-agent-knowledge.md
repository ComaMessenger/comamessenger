# Агент: знания

Маршрут `/agents/:agentId/knowledge`.

Текущая реализация — честный placeholder внутри SettingsSection: Key icon, title, объяснение будущих источников, компактное empty state «источников пока нет». Не рисовать несуществующий upload/indexing flow как готовый.

Для целевого дизайна можно подготовить расширяемую структуру: source cards (чат, документ, URL/MCP), status indexing/ready/error, scope/last sync, Add source CTA и empty onboarding. Однако пометить эти элементы как future concept, отдельно от current handoff. Общий readiness может показывать, требует ли template знания.
