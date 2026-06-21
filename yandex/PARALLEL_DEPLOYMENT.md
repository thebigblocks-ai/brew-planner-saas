# Полностью параллельный контур на Yandex Cloud

Цель: поднять отдельную копию планировщика без Supabase и проверить стабильность без VPN.

Итоговая схема:

```text
Новый GitHub repo
  -> GitHub Actions
  -> Yandex Object Storage site bucket
  -> браузер сотрудников
  -> Yandex API Gateway
  -> Yandex Cloud Function
  -> Yandex Object Storage private data bucket
```

## Что понадобится

1. Новый GitHub-репозиторий `brew-planner-ydx`.
2. Два бакета в Yandex Object Storage:
   - публичный бакет сайта;
   - приватный бакет данных.
3. Один сервисный аккаунт.
4. Static access key для сервисного аккаунта.
5. Cloud Function.
6. API Gateway.

## Единые имена для этого контура

Чтобы не путаться, в этой инструкции везде используется одно базовое имя:

```text
brew-planner-ydx
```

Проверь, что у тебя используются такие имена:

```text
GitHub repo:             brew-planner-ydx
Site bucket:             brew-planner-ydx
Data bucket:             brew-planner-ydx-data
Service account:         brew-planner-ydx-api
Cloud Function:          brew-planner-ydx-api
API Gateway:             brew-planner-ydx-gateway
Site URL:                https://brew-planner-ydx.website.yandexcloud.net
Function data prefix:    brew-planner
```

Важно: `brew-planner` в `Function data prefix` — это не название проекта и не бакет. Это папка внутри data-бакета, где будут лежать JSON-файлы данных.

## Шаг 1. Создать новый GitHub-репозиторий

Создай новый пустой репозиторий, например:

```text
brew-planner-ydx
```

В него нужно загрузить файлы проекта:

```text
index.html
README.md
assets/
yandex/
.github/
```

Для тестового контура можно загрузить тот же проект целиком.

## Шаг 2. Создать публичный бакет сайта

В Yandex Cloud открой:

```text
Object Storage -> Бакеты -> Создать бакет
```

Пример имени:

```text
brew-planner-ydx
```

Настройки:

- публичный доступ к чтению объектов включить;
- хостинг статического сайта включить;
- главная страница: `index.html`;
- страница ошибки: `index.html`.

После настройки у сайта будет адрес примерно такого вида:

```text
https://brew-planner-ydx.website.yandexcloud.net
```

Сохрани этот адрес. Он понадобится для `CORS_ORIGIN`.

## Шаг 3. Создать приватный бакет данных

Создай второй бакет:

```text
brew-planner-ydx-data
```

Настройки:

- публичный доступ не включать;
- статический сайт не включать.

В нем функция будет хранить:

```text
brew-planner/plan.json
brew-planner/users.json
brew-planner/action-logs.json
brew-planner/presence.json
```

## Шаг 4. Создать сервисный аккаунт

Открой:

```text
IAM -> Сервисные аккаунты -> Создать сервисный аккаунт
```

Имя:

```text
brew-planner-ydx-api
```

Выдай ему права:

```text
storage.editor
serverless.functions.invoker
```

Если в интерфейсе Yandex Cloud права назначаются на каталог, назначь их на каталог. Если назначаешь точечно на бакеты, для data-бакета нужен `storage.editor`.

Скопируй `ID` сервисного аккаунта. Он понадобится для API Gateway.

## Шаг 5. Создать static access key

В сервисном аккаунте открой:

```text
Создать новый ключ -> Статический ключ доступа
```

Сохрани два значения:

```text
access_key_id
secret_access_key
```

Важно: `secret_access_key` показывается один раз. Не вставляй его в `index.html` и не загружай в GitHub.

## Шаг 6. Подготовить архив Cloud Function

На компьютере открой папку:

```text
yandex/function
```

Выполни установку зависимостей:

```bash
npm install --omit=dev
```

После этого в папке должны быть:

```text
index.js
package.json
package-lock.json
node_modules/
```

Создай zip-архив так, чтобы `index.js` лежал в корне архива, а не внутри дополнительной папки.

Пример структуры архива:

```text
index.js
package.json
package-lock.json
node_modules/
```

## Шаг 7. Создать Cloud Function

Открой:

```text
Cloud Functions -> Создать функцию
```

Имя:

```text
brew-planner-ydx-api
```

Создай версию функции.

Настройки версии:

```text
Runtime: Node.js 20 или Node.js 22
Entry point: index.handler
Память: 256 MB
Timeout: 10 секунд
Service account: brew-planner-ydx-api
```

Загрузи zip-архив из шага 6.

Переменные окружения:

```text
YC_STORAGE_BUCKET=brew-planner-ydx-data
YC_STORAGE_PREFIX=brew-planner
YC_STORAGE_ENDPOINT=https://storage.yandexcloud.net
YC_STORAGE_REGION=ru-central1
YC_ACCESS_KEY_ID=<access_key_id>
YC_SECRET_ACCESS_KEY=<secret_access_key>
JWT_SECRET=<длинная случайная строка>
ADMIN_EMAIL=<твоя почта администратора>
ADMIN_PASSWORD=<временный пароль администратора>
ADMIN_DISPLAY_NAME=<твое имя>
CORS_ORIGIN=https://brew-planner-ydx.website.yandexcloud.net
```

Для `JWT_SECRET` используй длинную случайную строку, например 50-80 символов.

После создания версии скопируй `ID функции`.

## Шаг 8. Проверить функцию напрямую

Открой в браузере:

```text
https://functions.yandexcloud.net/<FUNCTION_ID>
```

Ожидаемый ответ:

```json
{"ok":true,"service":"brew-planner-yandex-api"}
```

Если ответ про недостающие переменные окружения, проверь переменные в версии функции.

## Шаг 9. Создать API Gateway

Открой:

```text
API Gateway -> Создать API-шлюз
```

Имя:

```text
brew-planner-ydx-gateway
```

Возьми файл:

```text
yandex/api-gateway.yaml
```

Важно: используй свежую версию файла, где для пути `/{proxy+}` объявлен path-параметр `proxy`.

В нем замени:

```text
<FUNCTION_ID>
<SERVICE_ACCOUNT_ID>
```

на реальные значения:

- `FUNCTION_ID` — ID функции;
- `SERVICE_ACCOUNT_ID` — ID сервисного аккаунта.

Вставь получившийся YAML в спецификацию API Gateway и создай шлюз.

После создания скопируй домен API Gateway. Он будет выглядеть примерно так:

```text
https://xxxx.apigw.yandexcloud.net
```

## Шаг 10. Проверить API Gateway

Открой:

```text
https://xxxx.apigw.yandexcloud.net/health
```

Ожидаемый ответ:

```json
{"ok":true,"service":"brew-planner-yandex-api"}
```

## Шаг 11. Проверить логин администратора

Открой DevTools в браузере или любой REST-клиент и отправь:

```http
POST https://xxxx.apigw.yandexcloud.net/auth/login
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

После этого в приватном data-бакете должен появиться файл:

```text
brew-planner/users.json
```

## Шаг 12. Переключить `index.html` на Yandex API

В тестовом репозитории, именно в копии проекта, открой `index.html`.

Найди строки:

```js
window.BREW_PLANNER_BACKEND_MODE = window.BREW_PLANNER_BACKEND_MODE || "supabase";
window.BREW_PLANNER_YANDEX_API_BASE_URL = window.BREW_PLANNER_YANDEX_API_BASE_URL || "";
```

Замени на:

```js
window.BREW_PLANNER_BACKEND_MODE = "yandex";
window.BREW_PLANNER_YANDEX_API_BASE_URL = "https://xxxx.apigw.yandexcloud.net";
```

Именно после этого тестовая копия перестанет обращаться к Supabase.

## Шаг 13. Загрузить сайт в публичный бакет

Автоматический деплой сайта уже описан в файле:

```text
.github/workflows/deploy-yandex-object-storage.yml
```

Он делает следующее:

- при каждом изменении в ветке `main` берет файлы из GitHub;
- загружает `index.html` в корень бакета;
- загружает папку `assets/`;
- загружает `README.md` и `readme.txt`, если они есть.

Чтобы он заработал в репозитории `brew-planner-ydx`, в GitHub нужно настроить secrets.

Открой новый GitHub-репозиторий:

```text
brew-planner-ydx
```

Перейди:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Добавь три секрета:

```text
YC_ACCESS_KEY_ID
YC_SECRET_ACCESS_KEY
YC_BUCKET=brew-planner-ydx
```

Значения:

```text
YC_ACCESS_KEY_ID = access_key_id от static key
YC_SECRET_ACCESS_KEY = secret_access_key от static key
YC_BUCKET = brew-planner-ydx
```

Важно: `YC_BUCKET` должен быть именно публичным бакетом сайта, не data-бакетом.

Правильно:

```text
YC_BUCKET=brew-planner-ydx
```

Неправильно:

```text
YC_BUCKET=brew-planner-ydx-data
```

После добавления secrets загрузи в GitHub файлы проекта. В корне репозитория обязательно должен быть файл:

```text
index.html
```

Не `index-2.html`, не `index copy.html`, а именно `index.html`.

Дальше:

1. Сделай commit в ветку `main`.
2. Открой вкладку `Actions` в GitHub.
3. Выбери workflow `Deploy to Yandex Object Storage`.
4. Дождись зеленой галочки.

Если workflow не стартовал сам, нажми:

```text
Actions -> Deploy to Yandex Object Storage -> Run workflow
```

После успешного workflow в бакете `brew-planner-ydx` должны появиться:

```text
index.html
assets/
README.md
readme.txt
```

Если в бакете пусто, значит workflow не запускался или упал с ошибкой. В этом случае открой последнюю попытку во вкладке `Actions` и посмотри красный шаг.

Важно: это могут быть те же static keys сервисного аккаунта, но безопаснее позже сделать отдельный ключ/аккаунт только для деплоя сайта.

## Шаг 14. Проверить работу сайта без VPN

Открой без VPN:

```text
https://brew-planner-ydx.website.yandexcloud.net
```

Проверь:

1. Вход под администратором.
2. Создание площадки.
3. Создание ЦКТ.
4. Создание цикла.
5. Обновление страницы.
6. Изменения сохранились.
7. Войти с другого компьютера без VPN.
8. Увидеть те же данные.
9. Изменить стадию с одного компьютера.
10. Через 10-15 секунд увидеть обновление на втором компьютере.

## Шаг 15. Как понять, что Supabase больше не используется

Открой DevTools -> Network.

При работе тестового сайта не должно быть запросов к:

```text
supabase.co
cdn.jsdelivr.net/npm/@supabase
```

Должны быть запросы только к:

```text
website.yandexcloud.net
apigw.yandexcloud.net
```

## Шаг 16. Как проверять стабильность

Тест на 20-30 минут:

1. Открыть тестовый сайт без VPN на двух компьютерах.
2. На первом добавить площадку, ЦКТ, цикл, комментарий.
3. На втором каждые 10-15 секунд проверять, что данные появляются.
4. На втором изменить стадию и распределение по таре.
5. На первом проверить, что данные обновились.
6. Несколько раз обновить страницу.
7. Проверить, что индикатор базы не уходит стабильно в красный.
8. Открыть Network и убедиться, что красных запросов к `apigw.yandexcloud.net` нет.

## Ограничения первого Yandex-варианта

Этот вариант сделан как быстрый стабильный контур для небольшой команды.

Что важно:

- данные плана сохраняются целиком одним JSON;
- realtime заменен на автообновление примерно раз в 10 секунд;
- при одновременном сохранении двух пользователей теоретически последнее сохранение может перезаписать предыдущее;
- если тест пройдет хорошо, следующий шаг — перенести хранение с JSON в YDB и добавить контроль версий.

Для проверки стабильности без VPN этого варианта достаточно.
