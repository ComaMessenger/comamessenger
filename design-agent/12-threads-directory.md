# Каталог тредов

Маршрут `/threads`, utility-screen без chat-list колонки.

Header с mobile Back и заголовком «Треды». Lead «Треды, на которые вы подписаны». Основной вертикальный список: avatar/контекстная пиктограмма, до 90 символов root message, число ответов, справа chevron/open affordance. Клик открывает соответствующий chat и thread.

Предусмотреть skeleton, inline network error и пустое состояние «Нет тредов». На desktop контент расположен в большой рабочей surface и не растягивает текст на всю ширину; на mobile занимает экран над tab bar. Строка должна выдерживать Markdown, CJK, длинный URL и удалённый root без поломки layout.
