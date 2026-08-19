# Фаза 3. Web-клиент MVP

Статус: завершена 2026-08-19.

## Цель

Собрать быстрый и визуально цельный responsive web-мессенджер поверх зафиксированного API. В конце фазы небольшая команда может использовать desktop, tablet или мобильный браузер как основной клиент для чатов, каналов и тредов без обращения к API вручную.

## В scope

- bootstrap, login, logout, принятие приглашения и профиль;
- основной desktop/tablet layout;
- полноценный phone layout с одноэкранной навигацией list → chat → thread;
- мобильный список с крупными карточками, аватарами, preview/unread и chips «Все» (default), «Личные», «Групповые»;
- списки личных чатов, групповых чатов, каналов и тредов;
- лента сообщений с виртуализацией и стабильной прокруткой;
- composer, markdown-подмножество, reply, треды, реакции, edit/delete, pin и forward;
- unread, mentions, read markers, drafts, typing и presence;
- reconnect/resume и понятные состояния отправки;
- создание и управление чатами/каналами в рамках доступных прав;
- светлая и тёмная темы через единые design tokens;
- RU/EN локализация;
- базовая accessibility и responsive layout от desktop до phone width;
- web push notifications;
- общий platform-neutral client engine и design tokens для последующего React Native клиента.

## Вне scope

- нативные mobile gestures, haptics и platform navigation уровня приложения фазы 6; responsive phone Web входит в scope;
- файлы, поиск и link previews до фазы 4;
- экран настройки агентов до фазы 5;
- звонки, задачи, опросы, кастомные emoji;
- pixel-copy Pachca: создаётся самостоятельная визуальная система без копирования бренда и ассетов;
- дополнительные локали кроме RU/EN до полной готовности исходных каталогов и review носителями языка;
- перенос GPL-кода Telegram Web или backend-locked UI kits в Apache-licensed web client.

## Пользовательские сценарии

- Owner проходит первоначальную настройку и попадает в пустое рабочее пространство с понятным следующим действием.
- Пользователь создаёт чат или канал и сразу понимает различие прав публикации.
- Пользователь быстро читает длинную историю, переходит к первому непрочитанному и возвращается к текущему сообщению.
- Пользователь отвечает цитатой в ленте или ведёт обсуждение в правой панели треда.
- При потере сети отправленное сообщение имеет явный статус и безопасно повторяется без дубля.
- Черновик сохраняется при переключении чатов и синхронизируется между вкладками/устройствами.
- Пользователь управляет интерфейсом клавиатурой и получает уведомления только согласно своим настройкам.
- Пользователь на телефоне сначала видит привычный список диалогов с крупными touch-target карточками, выбирает фильтр и открывает чат без уменьшенной desktop-панели.

## Технические задачи

### Инкремент 3.0 — contract gate

- [x] Поддерживать [инвентаризацию клиентских контрактов](03-web-client-contracts.md) от committed OpenAPI и WS schemas.
- [x] Добавить Chat summary для sidebar/mobile cards: DM identity, activity и bounded last-message preview.
- [x] Добавить paginated actors directory для DM/group/member picker и structured mentions.
- [x] Добавить bounded message window вокруг target для deep-link/reply/mention jump.
- [x] Реализовать durable producers `chat.*`/`member.*` в Core с transactional event и after-commit wake-up.
- [x] Зафиксировать Web Push subscription/preferences API до реализации browser permission flow.
- [x] Расширять `MessengerAPI` только generated типами закоммиченных endpoints.

### Архитектура клиента

- [x] Создать `@comamessenger/tokens` с platform-neutral light/dark semantic tokens и генерацией CSS variables для Web.
- [x] Разделить `packages/core` на API, realtime, vanilla store, outbox и markdown AST без импортов React/DOM.
- [x] Проверять в CI отсутствие React dependency/imports в `packages/core`.
- [x] Использовать Zustand vanilla для event-lived domain state, а TanStack Query — только для request-lived server state.
- [x] Не хранить message collections и chat summaries одновременно в Zustand и Query cache; REST snapshots проходят через те же reducers.
- [x] Подключить platform adapters для WebSocket, IndexedDB, clock/connectivity и auth lifecycle.
- [x] Использовать TanStack Router для typed deep links, TanStack Virtual для feed, `idb` для Web storage и i18next + i18next-icu для catalogs.
- [x] Не создавать универсальный `@coma/ui`: Web primitives остаются в `apps/web`, решение пересматривается на старте фазы 6 по ADR-0009.

### Design foundation

- [x] Зафиксировать информационную архитектуру и макеты ключевых состояний до сборки компонентов.
- [x] Описать tokens для light/dark: semantic colors, typography/CJK fallback, spacing, radius, elevation, motion.
- [x] Создать базовые доступные компоненты: button, input, dialog, menu, tooltip, popover, avatar, badge, toast, skeleton.
- [x] Добавить каталог компонентов или отдельный dev route для визуальной проверки состояний.
- [x] Определить правила плотности интерфейса, ширины колонок и поведения правой панели.
- [x] Зафиксировать phone navigation и крупную chat card: avatar, title, preview, time, unread/mention, kind marker и touch target.
- [x] Добавить chips «Все», «Личные», «Групповые»; «Групповые» включает chats и channels, различимые по kind marker.
- [x] Встроить i18n-safe layout policies и pseudo-locale в component review с первого примитива.
- [x] Исключить зависимость доменных компонентов от конкретных hex/px вне tokens.
- [x] Проверять лицензии UI dependencies/assets; визуальные паттерны реализовывать самостоятельно без переноса GPL/закрытого исходного кода.
- [x] Добавить production CSP без `unsafe-inline` для application code и E2E-проверку запрета inline script/HTML rendering.

### Состояние и данные

- [x] Разделить server state и transient UI state; не дублировать один источник истины в нескольких stores.
- [x] Подключить generated API client и типизированную обработку error envelope.
- [x] Реализовать единый realtime coordinator с reconnect, resume и дедупликацией событий.
- [x] Применять REST snapshots и WS events к domain store одним набором reducers; Query invalidation использовать только для request-lived данных.
- [x] Реализовать optimistic messages с состояниями sending/sent/failed/retrying.
- [x] Хранить offline outbox и realtime checkpoint в IndexedDB; повтор использует исходный `client_msg_id`.
- [x] Сохранять минимальный локальный state без access/refresh token в небезопасном storage.
- [x] Для нескольких вкладок держать отдельный WS; через BroadcastChannel передавать только `logout/auth_changed`, никогда сами tokens.

### Auth и onboarding

- [x] Реализовать bootstrap wizard, login, invitation acceptance и logout.
- [x] Добавить session-expired flow с возвратом к исходному маршруту после входа.
- [x] Реализовать редактирование display name, handle, timezone и preferences.
- [x] Обработать empty/loading/error/forbidden states всех экранов.

### Навигация и лента

- [x] Создать sidebar с разделами «Личные», «Чаты», «Каналы», «Треды» и unread badges.
- [x] На phone заменить sidebar полноэкранным списком больших chat cards; chat/thread открываются как следующий экран с предсказуемым Back.
- [x] Добавить поиск/фильтр по локально загруженному списку пространств; глобальный поиск появится в фазе 4.
- [x] Виртуализировать сообщения с загрузкой истории вверх и сохранением scroll anchor.
- [x] Поддержать переход к reply/root/mention с дозагрузкой нужной страницы.
- [x] Отображать separator первого непрочитанного и кнопку возврата вниз.
- [x] Корректно показывать deleted/edited/system messages.
- [x] Строить grouping/day separators как derived view, не записывать presentation groups в domain store.
- [x] Зарезервировать стабильные измеряемые placeholders для будущих attachments фазы 4.

### Composer и действия

- [x] Реализовать multiline composer, горячую клавишу отправки и согласованное markdown-подмножество.
- [x] Добавить structured autocomplete `@user` с server-validated actor IDs. `@all`/`@here` остаются за отдельным permission/notification контрактом, `@agent` — за фазой 5; клиент не имитирует отсутствующий API.
- [x] Реализовать reply preview, thread composer и явное различие reply/thread.
- [x] Добавить реакции, edit, delete, pin, copy link и forward.
- [x] В канале скрыть composer для member и объяснить, что писать могут только owner/admin; backend остаётся источником истины.
- [x] Синхронизировать drafts с debounce и flush при blur; unload гарантирует локальную запись, а следующий запуск повторяет server sync с разрешением конфликтов по версии.

### Уведомления и доступность

- [x] Реализовать permission flow для Web Push только после явного действия пользователя, без запроса при первом визите.
- [x] Создать service worker и обработку клика по уведомлению с deep link в chat/thread.
- [x] По умолчанию показывать в push отправителя и чат; body preview включается отдельной настройкой.
- [x] Подавлять push для активного chat/thread, не связывая эту оптимизацию с durable WebSocket delivery.
- [x] Добавить ARIA-labels, видимый focus, корректный focus trap и live region для новых сообщений.
- [x] Проверить клавиатурную навигацию по sidebar, ленте, меню и composer.
- [x] Соблюдать `prefers-reduced-motion` и достаточный contrast.
- [x] На phone учитывать safe-area insets, экранную клавиатуру, минимальный touch target 44px и увеличенный системный текст.

### Локализация

- [x] Ввести единый ICU-compatible message catalog с полными RU/EN переводами; пользовательские строки не хранить напрямую в компонентах.
- [x] Маппить стабильные server error codes на клиентские переводы, не показывая англоязычный backend message как основной UX.
- [x] Использовать `Intl` для дат, времени, чисел и plural rules с учётом timezone пользователя.
- [x] Добавить CI-проверку отсутствующих/лишних ключей и pseudo-locale для длинных строк/непереведённых фрагментов.
- [x] Добавить CI-проверку пользовательских строк вне catalog и синхронности RU/EN keys.
- [x] Использовать CSS logical properties там, где это не ухудшает читаемость, чтобы не заблокировать будущий RTL.
- [x] ES/PT/ZH и другие локали добавлять как beta только с явной маркировкой и community review; для CJK отдельно проверить layout и search strategy.

## Порядок реализации

Каждый инкремент остаётся deployable; рискованные части проверяются раньше декоративной полировки:

1. Contract gate 3.0, `packages/tokens`, router, i18n/pseudo-locale, themes, доступные primitives и component catalog.
2. Read-only desktop + phone chat list и virtualized history: prepend anchor, bottom pinning, unread separator и targeted jump.
3. Realtime coordinator: live reducers, reconnect/resume/resync и connection indicator.
4. Composer: optimistic message, persistent outbox, retry, markdown AST, channel read-only state.
5. Reply/thread UI: quote in feed, desktop side panel, phone separate screen, followed threads.
6. Reactions, edit/delete, pin и forward через message actions.
7. Unread/read markers, structured mentions и versioned drafts.
8. Typing/presence и active-screen lease.
9. Web Push service worker, explicit permission CTA, preferences и active-chat suppression.
10. Accessibility, keyboard, visual regression, 10k-message performance и E2E acceptance suite.

Шаг 1 может идти параллельно с server contracts 3.0. Chat list принимает реальные данные только после summary contract; Push не имитируется до готовности backend path.

## Контракты и данные

- Маршруты приложения имеют стабильные deep links: `/chats`, `/chat/:chatId`, `/chat/:chatId/thread/:threadId`, `/threads`; chat filter хранится как typed search param `all|direct|grouped` с default `all`.
- UI использует `kind` для названия и поведения: `group` отображается как «Чат», `channel` как «Канал».
- Client cache keys и realtime reducers документируются рядом с protocol package.
- Для Web Push добавляются API регистрации, обновления и удаления subscription.
- Permission запрашивается только после готовности service worker и успешной проверки поддержки Push API.
- Каждое optimistic сообщение связывается с серверным результатом через `client_msg_id`.

## Критерии приёмки

- Два пользователя проходят путь invite → login → chat → realtime message только через UI.
- Member канала видит read-only состояние; admin видит composer и публикует сообщение.
- При offline/online и перезагрузке вкладки сообщение не дублируется и получает корректный статус.
- Уведомления можно включить явным действием; отказ браузера не блокирует работу мессенджера и не вызывает повторных навязчивых запросов.
- Лента с 10 000 локально смоделированных сообщений остаётся интерактивной и не теряет anchor при prepend.
- На phone-width список чатов, chat и thread работают как отдельные экраны; chips, cards, unread и Back доступны touch и screen reader.
- Reply и thread визуально и поведенчески различимы без инструкции.
- Все основные сценарии доступны в RU/EN и light/dark.
- Ключевые действия выполняются клавиатурой без ловушек фокуса.

## Проверка качества

- Component tests всех интерактивных примитивов и доменных состояний.
- Vitest + Testing Library для unit/component tests, Playwright для browser E2E и visual regression.
- End-to-end тесты bootstrap, invite, chat/channel creation, messaging, thread, reconnect и read-only channel.
- Visual regression для основных экранов, тем, пустых и ошибочных состояний.
- Accessibility audit автоматическим инструментом плюс ручная клавиатурная проверка.
- Performance profiling длинной ленты, burst realtime events и переключения между чатами.
- Проверка нескольких вкладок, истечения сессии и конфликтов черновика.

## Риски и открытые вопросы

- Zustand vanilla выбран для domain store; TanStack Query остаётся владельцем только request-lived server state по ADR-0009.
- Markdown subset и Enter/Shift+Enter зафиксированы и проверены в composer; расширение синтаксиса требует отдельного protocol change.
- Перестановка и скрытие элементов бокового меню не входят в MVP и могут быть добавлены без изменения навигационного контракта.
- Матрица Push реализована уровнями `all|mentions|none`, `muted_until`, privacy preview и active-chat suppression; новые уровни требуют отдельного ADR.

## Definition of Done

- Полный основной сценарий команды проходит через web без ручных API-вызовов.
- UI имеет согласованный design system, а не набор несвязанных экранов.
- E2E, visual regression и accessibility checks зелёные.
- Все ограничения каналов и memberships корректно отражены, но не полагаются только на UI.
- Файлы, поиск и агенты можно добавить без переделки навигации и realtime coordinator.
- `packages/core` не импортирует React/DOM и проходит отдельную CI-проверку архитектурной границы.

## Итоговая проверка

- `pnpm generate`, `pnpm lint`, `pnpm test`, `pnpm build`;
- `pnpm --filter @comamessenger/web check:i18n`;
- Playwright desktop/phone: responsive navigation, channel read-only, optimistic retry, 10 000 сообщений, light/dark visual snapshots;
- axe WCAG audit основных desktop/phone экранов;
- `go test ./...`, включая REST + WebSocket + preferences/subscription integration path;
- production Docker Compose smoke и HTTPS smoke на тестовом сервере.
