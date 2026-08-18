# Фаза 6. Мобильный клиент

## Цель

Выпустить пригодный для ежедневного использования мобильный клиент iOS/Android с нативными жестами, push notifications и предсказуемой работой при нестабильной сети. Клиент использует тот же публичный API и семантику, что и web.

## В scope

- React Native + Expo приложение для iOS/Android;
- общий protocol/API package и переиспользуемая доменная логика;
- login, invitation deep link, безопасное хранение сессии;
- списки личных чатов, чатов, каналов и тредов;
- виртуализированная лента, composer, reply, треды, реакции и действия;
- swipe-to-reply, long-press menu и haptics;
- загрузка/просмотр файлов и поиск;
- push через APNs/FCM с маршрутизацией в chat/thread;
- локальный кэш последних данных и offline queue отправки;
- background/foreground lifecycle, resume и badge counts;
- RU/EN, light/dark и базовая mobile accessibility;
- internal distribution через TestFlight и Android internal testing.

## Вне scope

- полный offline-first архив всей организации;
- звонки, screen share и запись аудио;
- tablet/desktop-class многоколоночный интерфейс как отдельный продукт;
- собственная push-инфраструктура без APNs/FCM;
- публикация в публичные stores до стабилизации internal builds.

## Пользовательские сценарии

- Пользователь входит, получает push, нажимает его и попадает к конкретному сообщению или треду.
- Пользователь читает недавно загруженные сообщения без сети и видит, что данные могут быть неактуальны.
- Пользователь отправляет сообщение offline; после восстановления сети оно отправляется один раз.
- Свайп по сообщению включает reply с haptic feedback, long press открывает доступные действия.
- Member канала видит read-only composer state, а admin публикует сообщение.
- После возвращения из background клиент возобновляет события и синхронизирует read markers/badges.

## Технические задачи

### Основа приложения

- [ ] Инициализировать Expo-проект и выбрать поддерживаемую стратегию managed/prebuild.
- [ ] Настроить app variants, environment config, bundle IDs и signing без хранения секретов в репозитории.
- [ ] Переиспользовать generated protocol client; выделить transport/session adapters для web/mobile.
- [ ] Хранить refresh/session material в SecureStore/Keychain/Keystore, не в AsyncStorage.
- [ ] Настроить crash boundary, structured diagnostics и безопасный redaction.

### Навигация и интерфейс

- [ ] Создать auth stack и основной tab/navigation flow.
- [ ] Реализовать списки «Личные», «Чаты», «Каналы», «Треды» и unread badges.
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
- [ ] Возобновлять durable events с checkpoint после foreground/network restore.
- [ ] Периодически сверять sidebar/unread snapshot для восстановления после `resync_required`.

### Push notifications

- [ ] Реализовать регистрацию APNs/FCM token с привязкой к session/device.
- [ ] Обновлять token при rotation и удалять при logout/revocation.
- [ ] Учитывать mute, active session, mention preferences и privacy preview settings на сервере.
- [ ] Не включать чувствительный message body в push, если policy запрещает preview.
- [ ] Реализовать deep links для chat/message/thread и fallback при удалённом/недоступном объекте.
- [ ] Синхронизировать app icon badge с серверным unread snapshot.

### Файлы и platform integration

- [ ] Реализовать camera/photo/file picker с permission rationale.
- [ ] Поддержать background-friendly multipart upload в пределах возможностей платформы.
- [ ] Безопасно открывать downloads через системный viewer/share sheet.
- [ ] Не сохранять приватные файлы в публичные каталоги без явного действия пользователя.

## Контракты и данные

- Device registration содержит platform, push token, app version, locale и privacy-safe device metadata.
- Outbox хранит стабильный `client_msg_id`, локальный payload и состояние retry.
- Deep links имеют версионированную HTTPS/universal-link форму и custom scheme только как fallback.
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

- Подтвердить Expo managed/prebuild после проверки background uploads и нативных push требований.
- Выбрать локальную БД и политику максимального cache size.
- Определить минимальные версии iOS/Android.
- Решить, допускается ли показывать message preview на lock screen по умолчанию.
- Уточнить требования к tablet layout перед store release.

## Definition of Done

- iOS/Android internal builds проходят основной пользовательский сценарий.
- Offline/reconnect/push сценарии покрыты воспроизводимыми тестами.
- Mobile не вводит отдельную несовместимую бизнес-логику или приватный API.
- Security review локального storage, links и push payload завершён.
- Known platform limitations документированы перед production readiness.
