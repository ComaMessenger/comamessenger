# Общая активность агентов

Маршрут `/agents/activity`, permission `agents.observe`.

Header «Активность» и пояснение. Сверху stat grid: опубликовано/всего агентов, test runs, failed tests, среднее время до первого теста, среднее время до публикации. Неизвестное/нулевое время — `—`; duration локализован.

Ниже directory grid агентов: Activity icon, имя, `@handle`, readiness state. Клик открывает `/agents/:id/activity`. Состояния: skeleton metrics; метрики частично недоступны; empty с bot icon и подсказкой; длинный список. На mobile stats становятся 2×N или одной колонкой с ясной связью label/value.
