# Агент: обзор

Маршрут `/agents/:agentId`.

Общая detail shell: слева каталог, справа toolbar с именем/handle; tabs Обзор, Поведение, Знания, Автоматизации, Тест, Активность, Настройки согласно permissions. Сразу под tabs — readiness card: Ready или Needs setup, список недостающих шагов/проблем.

Основной блок lifecycle: draft version и published version показаны раздельно. Primary Publish при наличии готового draft; Pause для active published; Resume для paused. Никогда не создавать впечатление, что Save автоматически меняет production. Ниже version history со статусами/датами и Rollback, где разрешено.

Второй блок Usage: today cost, month cost, monthly runs, today tokens. Значения компактные, с табличными цифрами и понятным отсутствием данных.

Состояния: никогда не опубликован; draft совпадает с published; draft новее; active; paused; needs attention; publish/pause/resume pending/error; rollback confirmation/result. Observer видит данные без mutation controls.
