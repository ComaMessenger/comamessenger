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

## Android: APK для прямой раздачи

Подписанный Release APK собирается локально тем же upload-keystore
(`~/.coma/coma-upload.jks`, пароли — `COMA_UPLOAD_*` в
`~/.gradle/gradle.properties`, подписывает плагин `withAndroidReleaseSigning`):

```sh
cd apps/mobile
GOOGLE_SERVICES_FILE=… COMA_PUSH_RELAY_URL=https://push.coma-chat.com \
  COMA_BUILD_NUMBER=<versionCode> CI=1 npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease \
  -PreactNativeArchitectures=armeabi-v7a,arm64-v8a --max-workers=2
# app/build/outputs/apk/release/app-release.apk
~/Library/Android/sdk/build-tools/<версия>/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

- `versionCode` берите больше последнего в Google Play (`bundle exec fastlane android next_build`),
  иначе APK не обновит установленное из Play и наоборот.
- Google Play переподписывает приложение своим ключом (Play App Signing). Приложение из
  Play и APK, подписанный upload-ключом, друг друга **не обновляют**: чтобы перейти,
  нужно удалить приложение (вместе с данными входа). Если APK раздаётся рядом с Play,
  берите подписанный Google universal APK: Play Console → «Обзор App Bundle» →
  нужная версия → «Скачать» → «Подписанный универсальный APK».
- Без `GOOGLE_SERVICES_FILE` сборка проходит, но push на Android не работает.
- Устанавливают APK «из неизвестных источников»; Android 15+ спросит разрешение для
  браузера или файлового менеджера, из которого открыт файл.

## Google Play: закрытое тестирование и выход в продакшен

Аккаунт разработчика — личный, созданный после ноября 2023 года. Для таких аккаунтов
Google открывает продакшен только после закрытого теста: **не меньше 12 тестировщиков,
подписанных на тест 14 дней подряд**, затем заявка на доступ к продакшену с ответами
о тесте. Внутреннее тестирование (`internal`, куда грузит `fastlane android beta`)
в эти 14 дней не засчитывается.

1. Play Console → «Тестирование» → «Закрытое тестирование» → трек `alpha` → списки
   тестировщиков (адреса Google-аккаунтов или Google Group). Набирайте 15–20 человек:
   кто отпишется, тот выпадет из счёта.
2. Загрузка в закрытый трек: `GOOGLE_PLAY_TRACK=alpha apps/mobile/scripts/store-release.sh android`
   (или `GOOGLE_PLAY_TRACK=alpha bundle exec fastlane android beta`). Первую сборку на
   новый трек проверяет Google — от нескольких часов до нескольких дней.
3. Тестировщики принимают приглашение по ссылке «Присоединиться в Google Play» и
   ставят приложение из Play. Счёт 14 дней идёт, пока 12+ человек остаются в тесте;
   выпускайте обновления в этот период — Google смотрит на активность теста.
4. До отправки на проверку заполните: политика конфиденциальности (URL), «Безопасность
   данных», возрастной рейтинг, целевая аудитория, категория, контакты, «Доступ к
   приложению»: вход требует адрес сервера и учётную запись — дайте проверяющим
   демо-сервер (например `coma-chat.com`) и логин/пароль тестового пользователя.
5. Через 14 дней: «Панель управления» → «Подать заявку на доступ к продакшену».
   Ответ — до 7 дней. После одобрения — продакшен-трек и обычная проверка релиза.
