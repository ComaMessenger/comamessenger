# Мастер создания агента

Полноценный Dialog/flow из пяти шагов, запускается из каталога с custom либо recipe template. Header показывает title и «Шаг N из 5»; footer Back, Cancel, Continue/Create.

## Шаги

1. **Задача и идентичность.** Выбор/объяснение template, display name, автоматически генерируемый handle. Ошибка, если identity не заполнена.
2. **Доступ.** Выбор source chats чекбоксами и destination chat select. Recipe может требовать destination; объяснить, какие данные агент увидит.
3. **Детали сценария и запуск.** Instructions, fallback, tone (friendly/concise/formal), citations switch. Команда и/или время расписания с timezone в зависимости от template.
4. **Подключение.** Workspace LLM connection select с provider/health; можно «выбрать позже». Отдельный explicit switch согласия на external data sharing и заметка о безопасном старте.
5. **Проверка.** Definition list: задача, источники, destination, когда запускается, подключение, внешняя передача да/нет. Итоговая notice о том, что агент создаётся безопасно и сначала открывается Test.

## Требования

Прогресс должен сохранять введённое при Back; Continue блокируется только по требованиям текущего шага. Server error остаётся в dialog. Create pending предотвращает дубль. После успеха маршрут `/agents/:id/test`. На mobile мастер — fullscreen sheet/page, footer sticky над safe area, длинные списки прокручиваются отдельно.
