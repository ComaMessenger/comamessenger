# ADR-0009: общий клиентский движок, общие токены и платформенный UI

- Статус: принято
- Дата: 2026-08-19

## Контекст

Фаза 3 создаёт Web-клиент, а фаза 6 — React Native приложение. Нам нужно переиспользовать сложную логику доставки, offline outbox и представление доменного состояния, но Web и Native имеют разные layout primitives, accessibility APIs, navigation, gestures и performance constraints.

Общий пакет визуальных React-компонентов потребовал бы преждевременной прослойки над DOM и React Native. При этом копирование realtime/outbox/reducer логики между платформами намного опаснее, чем отдельная реализация кнопки или списка.

## Решение

### Общая часть

Создаём две платформенно-независимые границы:

```text
packages/tokens
└── semantic colors, typography, spacing, radius, elevation, motion

packages/core
├── api          typed MessengerAPI and transport/session boundary
├── realtime     WebSocket state machine, resume, ACK and resync
├── store        Zustand vanilla domain store and idempotent reducers
├── outbox       durable command queue and retry policy
└── markdown     supported-subset parser and platform-neutral AST
```

`packages/tokens` экспортирует типизированные значения light/dark. Web генерирует из них CSS custom properties, а React Native в фазе 6 использует те же значения в `StyleSheet`. Brand accent остаётся производным от `#174586`, основной шрифт — Onest с системным fallback stack.

`packages/core` не импортирует React, DOM APIs, React Native или platform storage напрямую. IndexedDB, WebSocket, clock, connectivity и secure/session lifecycle подключаются через маленькие concrete adapters на границе приложения. Ограничение «нет React imports/dependency в core» проверяется CI.

### Платформенная часть

- Web-примитивы и composition живут в `apps/web`; при реальном повторном использовании их можно позднее выделить в `packages/ui-web`.
- React Native компоненты в фазе 6 создаются отдельно против тех же tokens и client engine.
- Пакет `@coma/ui`/универсальный cross-platform UI в фазе 3 не создаётся. Решение пересматривается на старте фазы 6 по фактическим компонентам и требованиям NativeWind/Expo.

### Состояние

- Zustand `createStore` без React владеет event-lived state: chats summary, messages, unread, typing, presence и outbox status.
- TanStack Query владеет request-lived state: профиль, sessions, chat members, public directory, invitations и mutation lifecycle там, где результат не живёт в realtime store.
- Message collections и chat summaries не дублируются в Query cache. REST snapshots гидратируют domain store через один набор reducers.
- `apps/web` подписывается на vanilla store через узкие selectors; React-компоненты не реализуют delivery semantics.

### Навигация, локализация и разметка

- Web использует TanStack Router и типизированные deep links `/chats`, `/chat/:chatId`, `/chat/:chatId/thread/:threadId`, `/threads`. Один route tree рендерит desktop columns или phone navigation stack без двух независимых приложений.
- i18next + i18next-icu дают единые ICU-каталоги RU/EN и совместимы с будущим React Native.
- Даты, числа и plural rules форматируются через `Intl`.
- Markdown subset фиксируется как `bold`, `italic`, inline `code`, fenced `codeblock`, safe `link` и structured `mention`. Parser выдаёт AST в `packages/core`; платформы рендерят AST без HTML. `dangerouslySetInnerHTML` не используется.

Для Phase 3 зафиксированы конкретные Web dependencies: TanStack Router, TanStack Query, TanStack Virtual, Zustand vanilla, `idb`, i18next + i18next-icu, Vitest + Testing Library и Playwright. Они не становятся API `packages/core`, кроме vanilla store dependency; platform APIs остаются за adapters.

### Realtime и offline

Coordinator реализует явные состояния `connecting → authenticating → backlog → live → reconnecting`, а также `resync_required` и `session_expired`. Event применяется идемпотентно; checkpoint сохраняется после reducer commit и только затем может быть ACKed.

Outbox хранит исходный `client_msg_id`, payload и retry state в platform storage. Web adapter использует IndexedDB через `idb`. Timeout повторяет ту же команду; `idempotency_conflict` не ретраится.

Каждая вкладка держит собственный WebSocket. `BroadcastChannel` передаёт только сигналы `logout`/`auth_changed`; access/refresh tokens через него не пересылаются. Получив `auth_changed`, вкладка делает собственный refresh через HttpOnly cookie. SharedWorker/leader election отложены до доказанной необходимости.

## Последствия

- Основная correctness-логика пишется и тестируется один раз для Web и Native.
- Вёрстка остаётся естественной для платформы и не зависит от универсального UI abstraction.
- Появляются два небольших публичных внутренних контракта: tokens и client engine adapters.
- Phase 3 начинается с контрактной сверки и выделения packages, а не с переноса текущего `App.tsx` по папкам.
- Добавление новых dependencies требует проверки лицензии и реальной роли в выбранной границе.

## Точка пересмотра

На старте фазы 6 сравнить фактические Web-примитивы с требованиями React Native. Универсальный UI-пакет создаётся только при доказанном значимом совпадении API и поведения; tokens и engine от этого решения не меняются.
