# Дизайн-система: обязательная основа

## Характер

Спокойный workspace UI с собственной идентичностью Coma. Основа — ясная иерархия, компактная плотность на desktop, комфортные touch targets на mobile. Никаких glassmorphism, декоративных градиентов и свечения. Синий — действие и selection, не сплошная окраска фона.

## Foundations

- Сетка: 8 px, допустимы половинные шаги 4 px.
- Desktop: global sidebar 220 px (collapsed 58), chat list 320 px, gap/padding shell 8 px.
- Основной content fluid; текст сообщения ограничен примерно 860–880 px.
- Breakpoints: 840 px для сжатого desktop, 640 px для mobile stack.
- Шрифт: Onest Variable; базовый UI 14/20; secondary 12–13; заголовки продукта 18–24, semibold.
- Радиусы: 8, 12, 16 и pill 999 px. Контролы: 32, 40, 48 px; touch target не меньше 44 px.

## Цветовые роли

Light: canvas `#f3f6fa`, sidebar `#eef3f8`, surface `#fff`, foreground `#182235`, muted `#566477`, border `#dce3ec`, primary `#174586`, primary-soft `#e3edf9`, danger `#bd3346`, success `#247a54`.

Dark: neutral charcoal canvas/surfaces, foreground near-white, primary `#7f91ff`; глубина через контраст поверхностей и border, без glow. Тема также должна принимать настраиваемый accent пространства.

## Библиотека компонентов

Собрать: Button (primary/secondary/ghost/danger/icon), IconButton+Tooltip, Field/Textarea/Select, SearchField, Switch, RadioOption, Tabs, Badge, Avatar (размеры, online, agent), Dialog, Popover/Menu, Toast/In-app notification, Skeleton, EmptyState, SettingsSection/Row, ChatRow, MessageRow, ReactionChip, Composer, Attachment, AgentStatus/Readiness, bottom tab bar.

Каждый интерактивный компонент имеет idle, hover, pressed, focus-visible, disabled, loading; мутации — pending/success/error. Анимации 120–180 ms и версия без движения для `prefers-reduced-motion`.

## Контент и адаптивность

- RU и EN равноправны; проверить псевдолокаль +40% длины.
- Пользовательский текст и URL переносятся, однострочные заголовки имеют явный ellipsis.
- Числа/время — tabular figures; badge выдерживает `99+`.
- Поля всегда с label сверху. На mobile формы и action rows складываются в одну колонку.
- Иконки — Lucide; SVG-логотип Coma используется только как бренд-марка.
- WCAG focus, клавиатурные меню, aria-семантика, контраст и screen reader labels обязательны.
