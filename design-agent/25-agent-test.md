# Агент: тест

Маршрут `/agents/:agentId/test`, безопасная песочница.

Header/section: «Песочница» и пояснение. В текущем agent-specific flow агент уже выбран; остаются Chat select и большой Prompt textarea. Primary «Запустить тест»/«Запускаем…».

Результат после run: визуально отдельная panel с итоговым текстом/ошибкой и definition list: tested version, model, tokens, cost, writes blocked. Песочница обязана ясно сообщать, что внешние записи заблокированы и какой draft/published version проверялся. Streaming/progress не должен выглядеть как зависание.

Состояния: нет connection/model, нет chat, пустой prompt, queued/running, success, provider error, timeout, budget/rate limit. Ошибка должна содержать следующий шаг. На mobile textarea и result занимают всю ширину; trace/метрики не требуют горизонтального scroll.
