# Сборки мобильного приложения для TestFlight и Google Play

Компиляция идёт в GitHub Actions (`.github/workflows/mobile-release.yml`), а
подпись и загрузка — на Mac владельца. Ключей для сторов в GitHub нет.

Почему так: локальная компиляция iOS загружает ноутбук настолько, что ломается
звук macOS, а держать ключ App Store Connect, сертификат Apple Distribution и
upload-keystore Android в облаке владелец не хочет.

## Одна команда

```sh
apps/mobile/scripts/store-release.sh ios            # из текущей ветки
apps/mobile/scripts/store-release.sh android main   # из указанной ветки
```

Что происходит:

1. Скрипт спрашивает у стора следующий номер сборки (`fastlane <platform> next_build`) — ключом с этого Mac.
2. Запускает в GitHub Actions сборку без ключей и ждёт её (iOS — `macos-26`, Android — `ubuntu-latest`, 15–30 минут; Mac в это время не нагружен).
   - iOS: архив Xcode, подписанный ad hoc, чтобы в нём сохранились права (App Group, push).
   - Android: `.aab` с отладочной подписью.
3. Скачивает результат в `apps/mobile/build/ci/<run>/` и запускает
   - `fastlane ios publish` — экспорт архива с сертификатом Apple Distribution из связки ключей и ключом App Store Connect, проверка прав расширения уведомлений, загрузка в TestFlight;
   - `fastlane android publish` — замена отладочной подписи на upload-keystore из `~/.gradle/gradle.properties`, загрузка в Play internal testing.

Подпись и загрузка занимают одну-две минуты.

## Что лежит в GitHub — окружение `store`

| Имя | Вид | Зачем |
|---|---|---|
| `APPLE_TEAM_ID` | переменная | команда в проекте Xcode |
| `COMA_PUSH_RELAY_URL` | переменная | адрес push-relay в сборке |
| `GOOGLE_SERVICES_JSON` | секрет | клиентская конфигурация Firebase; она всё равно лежит внутри каждого APK, это не ключ подписи |

## Что лежит только на Mac владельца

Ключ App Store Connect (`.p8`), сертификат Apple Distribution в связке ключей,
сервисный аккаунт Google Play, upload-keystore Android и его пароли. Пути — в
`apps/mobile/.env` и `~/.gradle/gradle.properties`.

## Полностью локальная сборка

По-прежнему работает (`bundle exec fastlane ios beta` / `android beta`), но
грузит Mac и ломает звук — только если GitHub недоступен.
