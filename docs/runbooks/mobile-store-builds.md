# Сборки мобильного приложения для TestFlight и Google Play

Сборки идут в GitHub Actions (`.github/workflows/mobile-release.yml`), а не на
ноутбуке: локальная сборка iOS загружает Mac так, что ломается звук macOS.

## Запуск

```sh
gh workflow run mobile-release.yml --ref main -f platform=both
gh workflow run mobile-release.yml --ref <ветка> -f platform=ios -f changelog="Что проверить"
```

Номер сборки берётся из стора (следующий после последнего), `ios/` и `android/`
создаются `expo prebuild` на машине сборки. iOS — раннер `macos-26`, Android —
`ubuntu-latest`. Локальный запуск (`bundle exec fastlane ios beta`) по-прежнему
работает с `apps/mobile/.env`.

## Учётные данные — окружение `store` в настройках репозитория

Переменные (не секретные): `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_TEAM_ID`,
`COMA_PUSH_RELAY_URL`.

Секреты:

| Секрет | Что это |
|---|---|
| `APPLE_API_KEY_P8` | ключ App Store Connect API (`.p8`, текстом) |
| `IOS_DIST_P12_BASE64`, `IOS_DIST_P12_PASSWORD` | необязательно: сертификат Apple Distribution; без него Xcode подписывает облачным сертификатом через ключ API |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | сервисный аккаунт Google Play |
| `GOOGLE_SERVICES_JSON` | `google-services.json` Firebase (push на Android) |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | upload-keystore Android (`base64`) |
| `COMA_UPLOAD_STORE_PASSWORD`, `COMA_UPLOAD_KEY_ALIAS`, `COMA_UPLOAD_KEY_PASSWORD` | пароли и псевдоним upload-keystore |

Оригиналы ключей — у владельца (пути в локальном `apps/mobile/.env`), в
репозиторий они не попадают. Запускать сборку могут только участники с правом
записи; секреты окружения недоступны запускам из форков.
