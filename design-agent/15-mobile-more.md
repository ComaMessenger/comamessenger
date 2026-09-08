# Mobile «Ещё»

Маршрут `/more`; значим только при ширине до 640 px. Полноэкранный scrollable utility-screen над нижним tab bar.

Верх: identity block с avatar/presence, имя и handle. Затем компактная карточка текущего пространства с логотипом, названием и подписью. Основной список крупных touch rows с icon, title, hint: пользовательский статус; DND; профиль; workspace settings (не для member); участники; уведомления; выход с email и danger styling.

Статус раскрывает Status dialog/sheet. DND раскрывает inline panel: 30 мин, 1 ч, 2 ч, до завтра 09:00, custom datetime + Apply, а при активном snooze — Resume. В collapsed row показывается срок.

Экран должен ощущаться как раздел, а не popover desktop-меню. Учесть sticky/обычный header, safe areas, клавиатуру для custom datetime, pending controls и очень длинное имя пространства. Выход требует ясной danger affordance, но не должен случайно нажиматься при скролле.
