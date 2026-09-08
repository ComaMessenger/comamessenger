# Общие диалоги, меню и overlay-состояния

Эти поверхности входят в дизайн, хотя не имеют собственных маршрутов.

## Поиск

Command-palette dialog: autofocus search; tabs «Чаты и люди» и «Сообщения и треды». People results объединяют chats и members. Messages tab добавляет type all/message/file и chat filter; запрос от 2 символов, debounce, skeleton/error/empty/load more. Footer desktop показывает keyboard hints. Result открывает chat/message. Mobile почти fullscreen.

## Создание и организация

- New chat: kind group/direct/channel, title, topic, actor multi-picker, visibility, validation; direct ограничен одним участником.
- New folder: name; searchable curated icon grid; 10 semantic colors; searchable multi-select chats; Create disabled без имени.
- Chat info: editable name/topic только управляющему, notification level всем, список участников, Cancel/Save.

## Сообщения

- Reaction picker с search/categories, открывается вверх/вниз по месту.
- Message menu перечислен в Conversation; danger group отделён divider.
- Forward: searchable multi-select chats, preview автора/текста, optional comment, count-aware CTA.
- Views & reactions: icon tabs; receipts показывают avatar/name/read time, reactions — avatar/name/emojis; loading/empty.
- Pinned: список закреплённых сообщений, loading/error/empty; клик прыгает в ленту.

## Профиль и уведомления

- Status: emoji button/picker, «Чем заняты?» text, expiry none/hour/day/week, presets, Clear при существующем статусе, Cancel/Save.
- Enable notifications: bell, browser/server explanation, Skip и primary Enable; denied/unsupported имеют отдельный текст и disabled action.
- In-app toast: avatar, title, preview, close; auto-dismiss, клик открывает контекст.

## Общие правила

Desktop dialog обычно 500 px, radius 16, border между header/body. Escape, backdrop и Close предсказуемы; focus trap/return focus обязательны. Меню rows 34–36 px desktop, минимум 44 px touch. На mobile сложные message dialogs fullscreen; простые confirmations могут быть bottom sheet. Pending не закрывает overlay; server error остаётся внутри.
