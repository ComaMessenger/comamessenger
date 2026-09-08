# Агент: запуски

Маршрут `/agents/:agentId/activity`.

SettingsSection «Запуски». Список строк: Play/status icon, `status · model`, correlation ID и человекочитаемая ошибка при наличии, справа дата/время. Клик выбирает run и раскрывает detail panel.

Detail: status, model, correlation ID, created at, error code/description. Для queued/running есть Cancel. В будущем здесь естественно добавить trace, tokens, cost, источники и tool calls, сохранив master-detail модель.

Состояния: loading, empty, selected, queued, running, succeeded, failed, canceled, cancel pending/error. Correlation ID копируемый и моноширинный, но не главная информация. На mobile detail открывается inline под строкой или sheet; дата не сжимает основной текст.
