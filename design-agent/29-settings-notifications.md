# Настройки: уведомления

Маршрут `/settings/notifications`, доступен всем; длинный последовательный экран с autosave.

## Секции

1. **In-app.** Switch уведомлений в открытой вкладке и switch звука.
2. **Browser push.** Status card server/browser permission, switch/CTA Activate, preview text switch.
3. **Сообщения.** Select/radio: все; direct+mentions; ничего. Отдельно threads: все ответы; mentions; ничего. Switches: reactions, invites, system events.
4. **Расписание.** Enable; Every day/Weekdays/Custom days; при custom — дни недели; From/To; явная timezone пользователя.
5. **DND.** Текущий snoozed-until либо hint; presets 30/60/120 минут и Resume.
6. **Email digest.** Только если SMTP доступен; частота/выключено.
7. **Diagnostics.** Server/VAPID и browser permission, Send test, список devices/subscriptions с UA/date/current-session и Disconnect; empty.
8. **Exceptions.** Чаты с notify override/mute и Reset to default; empty с подсказкой менять уровень в самом чате.

## UX-состояния

Autosave pending/success/error не должен прыгать. Browser denied — пояснение системных настроек, CTA disabled. Test показывает полный/частичный результат. Расписание не смешивать с DND: первое повторяется, второе временное. На mobile diagnostic rows и actions становятся одной колонкой и touch-friendly.
