# Настройки: оформление пространства

Маршрут `/settings/customization`, permission `branding.manage`.

Секция Brand identity: две asset cards — Workspace logo и Favicon. Каждая показывает preview/placeholder, file requirements, Upload и Remove при наличии. Ошибки формата/размера рядом с карточкой; upload/remove pending не блокирует вторую карточку.

Секция Accent color: native color well + Hex field, live preview небольшого UI-фрагмента с primary action. Значение валидируется как цвет; contrast preview должен показывать text/icon на accent в light/dark. Save обновляет shell/branding без reload.

На mobile cards и accent editor становятся одной колонкой. Предусмотреть прозрачный/светлый logo, broken image, favicon tiny preview, reset к brand default и недопустимый контраст.
