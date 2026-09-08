# Список чатов

Маршрут `/chats` с query `filter=all|direct|grouped|channel` либо `folder=<uuid>`.

## Desktop

Экран использует global sidebar и отдельную chat-list surface 320 px; справа — Welcome, пока чат не выбран. Header списка: «Чаты», количество, `+`; на mobile вместо этого логотип и имя пространства. Ниже search field «Поиск чатов» и горизонтально прокручиваемые chips: Все, Личные, Групповые, Каналы, затем пользовательские папки с цветной иконкой и кнопка создать папку.

## Строка чата

Круглый avatar; direct получает online marker. Верхняя строка: название, muted icon при необходимости, locale time/date. Нижняя: отправитель + preview для групп/каналов, либо topic/kind до первого сообщения; справа unread badge до `99+`, primary tone при mention. Если unread нет, pinned chat показывает pin. Pinned поднимаются вверх только внутри текущего фильтра. Выбранный chat имеет спокойный selected surface.

## Действия

Клик открывает `/chat/:id`. Context menu по right-click, Shift+F10 или long press: открыть в новом окне, pin/unpin (лимит 10), mute/unmute, mark read, membership по личным папкам, leave group/channel с подтверждением. Visible overflow-кнопки в строке нет.

## Состояния и mobile

Skeleton, inline network error, empty по текущему фильтру/search. На mobile экран полноширинный до tab bar; avatar около 46–48 px, строка минимум 64–72 px, title/time и preview/badge образуют две строки. Поиск 44 px. Filter и scroll сохраняются при возврате из чата. Длинные имена/preview — ellipsis, badge не сжимает текст.
