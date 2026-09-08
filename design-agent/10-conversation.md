# Беседа

Маршрут `/chat/:chatId`; на desktop третья поверхность рядом со списком, на mobile полноэкранный слой поверх списка.

## Header

Mobile Back; avatar; название; secondary status. Для direct: пользовательский status или должность. Для group/channel: topic или число участников. Во время активности приоритет имеют `Агент работает…`/несколько агентов, затем typing count. Справа search icon (на mobile скрыт) и info/members.

## Лента

Виртуализированная, центрированная, снизу вверх. В начале истории — intro с avatar, title, topic/«Начало чата», датой создания и Add members для group/channel. Есть разделители дат и «Новые сообщения». Подгрузка старых сообщений сохраняет позицию. При прокрутке вверх появляется круглая кнопка вниз с количеством новых.

Сообщения — строки, не bubbles. Первая строка группы показывает avatar, автора, agent badge, время, edited. Повторы одного автора до 5 минут компактны. Поддерживаются Markdown, reply quote с jump, изображения/видео/файлы, forwarded label, reactions, thread reply count, delivery sending/retrying/failed с Retry. Streaming агента — мягко подсвеченная строка с caret/status.

Hover toolbar desktop: reaction, thread, more. На mobile постоянно доступно только more. Меню: reaction, reply, thread, pin, copy link/text, forward, views/reactions, edit для автора, delete для автора/модератора. Overlay автоматически открывается вверх/вниз и не вылезает за viewport.

## Composer

Плавающая двухуровневая surface: растущий textarea сверху, toolbar снизу. Attach menu (media/file/markdown), emoji, mention, formatting `Aa`, primary send и chevron send settings. Formatting: bold, italic, underline, strike, link, heading, ordered/bullet list. Mention menu содержит участников и `@all/@here`. Reply strip и attachment strip живут над composer; upload показывает preview/progress/error/retry/cancel, максимум 10.

Enter/Shift+Enter режим хранится локально; send settings позволяет переключить его, scheduled send помечен «позже». Draft синхронизируется локально/на сервере. Channel member вместо composer видит read-only strip с megaphone.

## Состояния

Loading feed невидим до корректного позиционирования; empty; no more history; unread anchor; offline/outbox; failed attachment; deleted message; inaccessible/deleted chat. На mobile header учитывает safe area, feed имеет 8–12 px поля, composer не перекрывается tab bar/keyboard.
