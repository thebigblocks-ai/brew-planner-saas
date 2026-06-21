# Brew Planner: Yandex-only prototype

Эта папка содержит первый вариант полной Yandex-схемы без Supabase.

Подробная инструкция для полностью параллельного тестового контура:

```text
yandex/PARALLEL_DEPLOYMENT.md
```

## Что меняется

Текущая схема:

```text
Yandex Object Storage site -> browser -> Supabase
```

Новая схема:

```text
Yandex Object Storage site -> browser -> Yandex API Gateway -> Yandex Cloud Function -> Yandex Object Storage data
```

На первом этапе данные хранятся JSON-файлами в Object Storage:

- `brew-planner/plan.json` — площадки, ЦКТ, циклы, шаблоны сортов;
- `brew-planner/users.json` — пользователи, роли и хэши паролей;
- `brew-planner/action-logs.json` — журнал действий за 60 дней;
- `brew-planner/presence.json` — кто онлайн.

Это не требует Supabase и достаточно для тестирования с небольшой командой. Если позже понадобится полноценная база, этот же API можно перенести с Object Storage на YDB.

## 1. Создать отдельный бакет для данных

В Yandex Object Storage создай отдельный приватный бакет, например:

```text
brew-planner-data
```

Не делай его публичным. Публичным остается только бакет сайта.

## 2. Создать сервисный аккаунт

Создай сервисный аккаунт, например:

```text
brew-planner-api
```

Выдай ему права на приватный data-бакет:

```text
storage.editor
```

Если используешь API Gateway с этим же аккаунтом, ему также нужны права на вызов функции.

## 3. Создать статический ключ

Для сервисного аккаунта создай static access key.

Нужны два значения:

```text
access_key_id
secret_access_key
```

Их нельзя добавлять в `index.html`. Они задаются только в переменных окружения Cloud Function.

## 4. Создать Cloud Function

Runtime:

```text
Node.js 20 или Node.js 22
```

Entry point:

```text
index.handler
```

Source code:

```text
yandex/function/index.js
yandex/function/package.json
```

Переменные окружения функции:

```text
YC_STORAGE_BUCKET=brew-planner-data
YC_STORAGE_PREFIX=brew-planner
YC_STORAGE_ENDPOINT=https://storage.yandexcloud.net
YC_STORAGE_REGION=ru-central1
YC_ACCESS_KEY_ID=<static access key id>
YC_SECRET_ACCESS_KEY=<static secret key>
JWT_SECRET=<длинная случайная строка>
ADMIN_EMAIL=<почта первого администратора>
ADMIN_PASSWORD=<временный пароль первого администратора>
ADMIN_DISPLAY_NAME=<имя администратора, необязательно>
CORS_ORIGIN=https://<адрес сайта в Yandex Object Storage>
```

Для `JWT_SECRET` можно использовать любую длинную случайную строку. Например 40-80 символов.

## 5. Проверить функцию напрямую

После публикации функции открой ее HTTPS-ссылку:

```text
https://functions.yandexcloud.net/<FUNCTION_ID>/health
```

Ожидаемый ответ:

```json
{
  "ok": true,
  "service": "brew-planner-yandex-api"
}
```

## 6. Создать API Gateway

В файле `yandex/api-gateway.yaml` замени:

```text
<FUNCTION_ID>
<SERVICE_ACCOUNT_ID>
```

на реальные значения.

После создания API Gateway проверь:

```text
https://<api-gateway-domain>/health
```

Ожидаемый ответ такой же:

```json
{
  "ok": true,
  "service": "brew-planner-yandex-api"
}
```

## 7. Проверить логин

Через любой REST-клиент или DevTools можно отправить:

```http
POST https://<api-gateway-domain>/auth/login
Content-Type: application/json

{
  "email": "<ADMIN_EMAIL>",
  "password": "<ADMIN_PASSWORD>"
}
```

Ожидаемый ответ:

```json
{
  "user": {
    "role": "admin"
  },
  "token": "..."
}
```

При первом логине функция автоматически создаст `users.json` с первым администратором.

## 8. Следующий шаг

После того как `/health` и `/auth/login` работают, нужно переключить `index.html` с Supabase на этот API.

Для этого в клиенте появится режим:

```js
window.BREW_PLANNER_BACKEND_MODE = "yandex";
window.BREW_PLANNER_YANDEX_API_BASE_URL = "https://<api-gateway-domain>";
```

До получения реального адреса API Gateway рабочий `index.html` лучше не переключать.

## Что пока отличается от Supabase

- Realtime в первом варианте будет заменен на короткий polling.
- Авторизация хранится в нашем backend, не в Supabase Auth.
- Данные сохраняются целым планом, как сейчас делает интерфейс.
- Для маленькой команды это нормально. Для высокой одновременной нагрузки позже лучше перенести хранение в YDB и добавить защиту от конфликтов версий.
