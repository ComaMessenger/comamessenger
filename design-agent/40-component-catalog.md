# Внутренний каталог компонентов

Маршрут `/dev/components`, доступен только в development. Это QA-экран, не пользовательская функция.

Он должен показывать foundations и все primitives в light/dark: кнопки, icon buttons/tooltips, badges, avatars/presence, inputs/select/textarea, switch/radio, menus/popovers/dialogs, toast, skeleton, empty, chat row, message row, composer, settings rows и agent states.

Для каждого — default, hover/pressed (если возможно), focus-visible, disabled, loading, error, long RU/EN/pseudo locale. Отдельные mobile frames фиксируют touch size и wrapping. Экран полезен как источник variants для Figma и visual regression, поэтому компоненты должны быть названы так же, как в библиотеке дизайн-системы.
