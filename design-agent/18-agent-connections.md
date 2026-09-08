# Подключения агентов

Маршрут `/agents/connections`, глобальный уровень пространства.

Title «Подключения» и пояснение, справа Add для `integrations.manage`. Сетка карточек подключений: name, provider, default model либо «не задана», enabled/disabled и health badge, masked credential hint/metadata. Действия: Test connection, Enable/Disable, Delete. Используемое подключение нельзя удалять без понятного объяснения влияния.

Create dialog: name; provider; provider-dependent endpoint (canonical/OpenAI-compatible); default model; API key password field; security note, что secret шифруется и не возвращается. Cancel/Save, pending/error. Карточка после test показывает success/failure и время проверки.

Состояния: skeleton; empty с объяснением и CTA; read-only для наблюдателя; unhealthy/disabled; rate/network error; credential rotation. Не показывать полный secret ни в каком состоянии.
