# Фаза 6. Мобильный клиент

## Цель

Выпустить пригодный для ежедневного использования мобильный клиент iOS/Android с нативными жестами, push notifications и предсказуемой работой при нестабильной сети. Клиент использует тот же публичный API и семантику, что и web.

## В scope

- React Native + Expo приложение для iPhone и Android-телефонов (стек — [ADR-0011](../decisions/0011-mobile-stack.md));
- общий protocol/API package и переиспользуемая доменная логика;
- общие semantic design tokens при отдельной React Native вёрстке;
- login, invitation deep link, безопасное хранение сессии;
- списки личных чатов, чатов, каналов и тредов;
- виртуализированная лента, composer, reply, треды, реакции и действия;
- swipe-to-reply, long-press menu и haptics;
- загрузка/просмотр файлов и поиск;
- push через APNs/FCM и push-relay проекта ([ADR-0012](../decisions/0012-mobile-push-relay.md)) с маршрутизацией в chat/thread;
- локальный кэш последних данных и offline queue отправки;
- background/foreground lifecycle, resume и badge counts;
- RU/EN, light/dark и базовая mobile accessibility;
- internal distribution через TestFlight и Android internal testing.

## Вне scope

- полный offline-first архив всей организации;
- звонки, screen share и запись аудио;
- планшеты: первая версия только для телефонов;
- администрирование пространства, конструктор агентов, брендинг и аудит — остаются в web;
- собственная push-инфраструктура без APNs/FCM;
- публикация в публичные stores до стабилизации internal builds.

## Пользовательские сценарии

- Пользователь входит, получает push, нажимает его и попадает к конкретному сообщению или треду.
- Пользователь читает недавно загруженные сообщения без сети и видит, что данные могут быть неактуальны.
- Пользователь отправляет сообщение offline; после восстановления сети оно отправляется один раз.
- Свайп по сообщению включает reply с haptic feedback, long press открывает доступные действия.
- Member канала видит read-only composer state, а admin публикует сообщение.
- После возвращения из background клиент возобновляет события и синхронизирует read markers/badges.

## Этапы

| Этап                     | Результат                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| M0. Основа               | ADR-0011/0012, refresh-токен для native, `apps/mobile` на Expo, адаптеры core, CI, development build |
| M1. Вход и оболочка      | Адрес сервера, вход, восстановление пароля, приглашение, табы и список чатов, realtime lifecycle     |
| M2. Беседа               | Лента, markdown, composer, reply, реакции, треды, жесты, read markers, outbox в SQLite               |
| M3. Push и ссылки        | Device registration, push-relay, NSE/FCM-расшифровка, deep links, badges                             |
| M4. Файлы, поиск, агенты | Pickers, загрузки по URI, аватары, поиск, статусы и стриминг агентов                                 |
| M5. Offline и полировка  | Кэш последних данных, accessibility, настройки профиля/уведомлений/сессий                            |
| M6. Внутренняя раздача   | TestFlight, Google Play internal testing, security review, тесты на устройствах                      |

## Технические задачи

### Основа приложения

- [x] Выдавать refresh-токен в теле ответа для `X-Coma-Client: native` без Origin и принимать его в `POST /auth/refresh`; `MessengerAPI` принимает `RefreshTokenStore`.
- [x] Выбрать стратегию Expo: Continuous Native Generation + EAS Build ([ADR-0011](../decisions/0011-mobile-stack.md)).
- [x] Инициализировать `apps/mobile`: Expo SDK 57, expo-router, адаптеры SecureStore и SQLite, EAS-профили.
- [ ] Настроить app variants, environment config, bundle IDs и signing без хранения секретов в репозитории.
- [x] Переиспользовать generated protocol client; выделить transport/session adapters для web/mobile.
- [x] Переиспользовать `packages/core` engine и `packages/tokens`, не переносить DOM/Web primitives в Native. Хелперы списка чатов и инициалы перенесены в core; `websocketURL()` больше не зависит от сеттера `URL.protocol`, которого нет в React Native.
- [x] Хранить refresh/session material в SecureStore/Keychain/Keystore, не в AsyncStorage. Keychain переживает переустановку, поэтому новая локальная БД стирает старый токен; локальные данные привязаны к `user_id`.
- [ ] Настроить crash boundary, structured diagnostics и безопасный redaction.

### Навигация и интерфейс

- [x] Создать auth stack и основной tab/navigation flow: адрес сервера (или ссылка-приглашение целиком), вход, восстановление пароля, приглашение, экран «нет связи», `coma://invite`, табы «Чаты» и «Ещё».
- [ ] Реализовать списки «Личные», «Чаты», «Каналы», «Треды» и unread badges. Готов список чатов с фильтрами, поиском, закреплёнными и счётчиками; «Треды» — в M2.
- [ ] Использовать производительную виртуализацию списка сообщений с измерением разных высот.
- [ ] Реализовать composer, mentions, markdown rendering и attachments.
- [ ] Добавить swipe reply через Gesture Handler/Reanimated, long-press actions и haptics.
- [ ] Корректно обрабатывать клавиатуру, safe areas, rotation policy и accessibility font scaling.
- [ ] Реализовать agent streaming/status без блокировки UI.

### Синхронизация и offline

- [ ] Создать локальную БД/кэш с версионируемой схемой и миграциями.
- [ ] Хранить ограниченный набор последних chats/messages/threads и пользовательские preferences.
- [ ] Создать outbox с `client_msg_id`, retry/backoff и явным failed state.
- [ ] Не разрешать offline-изменения, которые нельзя безопасно разрешить, без предупреждения пользователя.
- [x] Возобновлять durable events с checkpoint после foreground/network restore: уход в фон закрывает сокет, возврат — resume с checkpoint, перезагрузка списка и flush outbox. Same-host `Origin` нативного WebSocket принимается сервером.
- [ ] Периодически сверять sidebar/unread snapshot для восстановления после `resync_required`.

### Push notifications

- [ ] Реализовать push-relay: регистрация platform token → `relay_handle`, доставка, `410` для удалённых handle.
- [ ] Реализовать регистрацию устройства на инстансе (`relay_handle`, ключ уведомлений) с привязкой к session.
- [ ] Шифровать payload ключом устройства; расшифровка в iOS Notification Service Extension и Android FCM handler.
- [ ] Обновлять token при rotation и удалять при logout/revocation.
- [ ] Учитывать mute, active session, mention preferences и privacy preview settings на сервере.
- [ ] Не включать чувствительный message body в push, если policy запрещает preview.
- [ ] Реализовать deep links для chat/message/thread и fallback при удалённом/недоступном объекте.
- [ ] Синхронизировать app icon badge с серверным unread snapshot.

### Файлы и platform integration

- [ ] Добавить в `MessengerAPI` file transport adapter: загрузка и скачивание по URI вместо `Blob`.
- [ ] Реализовать camera/photo/file picker с permission rationale.
- [ ] Поддержать background-friendly multipart upload в пределах возможностей платформы.
- [ ] Безопасно открывать downloads через системный viewer/share sheet.
- [ ] Не сохранять приватные файлы в публичные каталоги без явного действия пользователя.

### Проверка

- [x] Maestro-сценарий `apps/mobile/e2e/sign-in.yaml`: сервер → вход → список чатов (realtime live) → беседа → «Ещё».

## Контракты и данные

- Device registration содержит platform, push token, app version, locale и privacy-safe device metadata.
- Outbox хранит стабильный `client_msg_id`, локальный payload и состояние retry.
- Deep links: custom scheme `coma://` — основной вход; universal/App Links только на домене издателя (`/open?server=…&path=…`), домены инстансов в entitlements не попадают.
- Core предоставляет snapshot endpoint для восстановления sidebar/unread после потери event history.
- Mobile cache не становится источником серверных permissions.

## Критерии приёмки

- Internal iOS/Android builds устанавливаются на чистые устройства и подключаются к self-hosted instance.
- Offline message после восстановления сети создаётся ровно один раз.
- Push открывает правильный chat/thread, а revoked session больше не получает полезный payload.
- После background дольше event retention клиент выполняет full resync без потери локального draft/outbox.
- Основные жесты не конфликтуют со scroll и системной навигацией.
- Увеличенный системный шрифт и screen reader позволяют прочитать/отправить сообщение.

## Проверка качества

- Unit tests reducers, outbox, cache migrations и deep-link parser.
- Integration tests network transitions, token rotation и session revocation.
- E2E на минимум одном актуальном iPhone и двух классах Android устройств.
- Проверка slow network, airplane mode, process kill и OS background restrictions.
- Performance profiling длинной ленты, изображений и burst events.
- Privacy-проверка push payload, screenshots/app switcher и локального storage.

## Риски и открытые вопросы

Решено 2026-09-29: Expo CNG + EAS Build; отдельный UI поверх tokens без универсального пакета; `expo-sqlite` для локальных данных; iOS 16.4+ и Android 8.0+; только телефоны; preview на lock screen выключен по умолчанию (`push_preview`); публикация с личных аккаунтов Apple/Google; push через relay проекта.

Открыто:

- Публичный домен Coma — от него зависят bundle ID, universal links и адрес push-relay; нужен до первой внутренней сборки.
- Максимальный размер локального кэша.
- Где хостить push-relay и как мониторить его доступность.

## Definition of Done

- iOS/Android internal builds проходят основной пользовательский сценарий.
- Offline/reconnect/push сценарии покрыты воспроизводимыми тестами.
- Mobile не вводит отдельную несовместимую бизнес-логику или приватный API.
- Security review локального storage, links и push payload завершён.
- Known platform limitations документированы перед production readiness.
