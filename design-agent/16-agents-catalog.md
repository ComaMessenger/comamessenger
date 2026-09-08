# Каталог агентов

Маршрут `/agents`. Доступ зависит от agent permissions.

## Общая оболочка

В рабочей области отдельный header «Агенты» + пояснение и горизонтальные global tabs: Обзор, Подключения, Согласования, Активность. Вкладки фильтруются permissions и имеют icon + underline active. Контент scrollable.

## Каталог

Двухколоночный layout: слева 220–280 px каталог, справа editor/empty. Для builder сверху primary «Создать агента» и быстрые recipe-кнопки Summarizer, Q&A, Onboarding. Далее строки агентов: bot icon, display name, `@handle`, enabled/disabled. Клик ведёт в `/agents/:id`.

Без выбранного агента справа title/hint empty state. При выборе справа появляются toolbar, readiness и detail tabs. Если агентов нет — ясный сценарий создания, без технического жаргона.

Состояния: skeleton агентов/чатов; access denied; empty; error; длинный каталог; выбранный disabled/needs attention. На узком экране каталог и editor должны стать последовательными экранами/stack, а global/detail tabs — горизонтально прокручиваемыми. Не смешивать workspace global settings с настройками конкретного агента.
