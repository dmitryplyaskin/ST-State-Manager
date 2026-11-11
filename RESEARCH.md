# Кастомные вызовы модели и выбор модели в SillyTavern

Исследование под расширение **ST-State-Manager**: как из стороннего расширения
отправить запрос к модели отдельно от основной генерации и как выбрать модель
именно для этого запроса.

Проверено по локальному исходнику SillyTavern **1.19.0** (`F:\SillyTavern`,
ветка `main`, коммит `06bde939f`). Ссылки на файлы даны относительно корня
репозитория, с номерами строк на момент исследования.

---

## 1. TL;DR

| Задача | Решение |
| --- | --- |
| Отдельный вызов модели со своим профилем, ключом, пресетом и **своей моделью** | `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, options, { model })` — **рекомендуемый путь** |
| Вызов через текущее основное подключение с переопределением модели | прямой `POST /api/backends/chat-completions/generate` с полем `model` |
| Просто тихая генерация текущей моделью без выбора | `generateQuietPrompt()` / `generateRaw()` |
| Получить список моделей для выбора | `POST /api/backends/chat-completions/status` (chat) или `POST /api/backends/text-completions/status` (text); единого универсального endpoint нет |
| Гарантировать возможность выбора модели | поле свободного ввода + список-подсказка (`<input list="...">` + `<datalist>`), потому что часть провайдеров список не отдаёт |

Ключевой вывод: **модель можно переопределить на один конкретный запрос**, не
изменяя профиль и не трогая глобальные настройки: `ConnectionManagerRequestService.sendRequest`
принимает пятым аргументом `overridePayload`, который «размазывается» поверх
payload профиля (`public/scripts/extensions/shared.js:460`), поэтому
`{ model: "..." }` побеждает `profile.model`.

Практическая рекомендация для ST-State-Manager:

- вызывать модель через `ConnectionManagerRequestService.sendRequest`;
- модель передавать в `overridePayload.model`, а не менять `profile.model`;
- список моделей брать из `/status` как подсказку, но всегда оставлять
  свободный ввод;
- основное подключение использовать только как fallback для chat completion.

---

## 2. Как в SillyTavern устроен вызов модели

```
Браузер (расширение)
   │  fetch('/api/backends/chat-completions/generate',
   │        headers: { 'X-CSRF-Token': ... },
   │        body: { chat_completion_source, model, messages, ... })
   ▼
Node-сервер SillyTavern
   │  src/endpoints/backends/chat-completions.js:2242
   │  switch (chat_completion_source) → sendOpenAIRequest / sendClaudeRequest / ...
   │  ключ берётся из secret-хранилища: readSecret(..., secret_id)
   ▼
Провайдер (OpenAI, OpenRouter, Claude, custom endpoint, ...)
```

Следствия, важные для расширения:

1. **Ключи API не покидают сервер.** Расширение не должно их запрашивать и не
   должно хранить: сервер сам подставляет секрет по `chat_completion_source` и
   необязательному `secret_id`.
2. **CSRF обязателен.** Заголовки берутся из `getRequestHeaders()`
   (`public/script.js:647`): `Content-Type: application/json` и
   `X-CSRF-Token`. В контексте расширения это `SillyTavern.getContext().getRequestHeaders`.
3. **Два семейства API.** Chat completion (`/api/backends/chat-completions/*`) и
   text completion (`/api/backends/text-completions/*`). У них разные payload и
   разные списки моделей.
4. **События основной генерации не участвуют.** Прямой запрос не создаёт
   сообщение в чате и не запускает `GENERATION_STARTED` — это именно то, что
   нужно фоновому обновлению состояния.

---

## 3. Вариант A (рекомендуемый): Connection Manager

### 3.1. Что это

Встроенное расширение **Connection Manager** хранит «профили подключения»:
набор настроек API + модель + пресет + instruct + секрет. Профиль можно
применять к основному чату, а можно — к отдельному запросу через публичный
сервис `ConnectionManagerRequestService`.

- Класс: `public/scripts/extensions/shared.js:392`
- В контексте расширения: `SillyTavern.getContext().ConnectionManagerRequestService`
  (`public/scripts/st-context.js:294`)

### 3.2. Профиль подключения

Описание полей — `public/scripts/extensions/connection-manager/index.js:160`:

```js
/**
 * @typedef {Object} ConnectionProfile
 * @property {string} id
 * @property {string} mode            // 'cc' | 'tc'
 * @property {string} [name]
 * @property {string} [api]           // ключ CONNECT_API_MAP: 'openai', 'openrouter', 'custom', ...
 * @property {string} [preset]        // имя пресета генерации
 * @property {string} [model]         // модель профиля (снимок на момент создания/обновления)
 * @property {string} [proxy]         // ИМЯ пресета прокси, не URL
 * @property {string} [instruct]
 * @property {string} [api-url]       // URL сервера / custom endpoint
 * @property {string} [secret-id]     // id сохранённого секрета
 * ...
 */
```

Профили лежат в `extension_settings.connectionManager.profiles`
(`public/scripts/extensions.js:172`).

Важно: `profile.model` — это **снимок строки**, а не ссылка на текущую модель.
Смена модели в основном интерфейсе профиль не обновляет.

### 3.3. Сигнатура вызова

`public/scripts/extensions/shared.js:423`:

```js
ConnectionManagerRequestService.sendRequest(
  profileId,        // string
  prompt,           // string | ChatCompletionMessage[]
  maxTokens,        // number
  custom = {        // необязательные флаги
    stream: false,
    signal: null,
    extractData: true,
    includePreset: true,
    includeInstruct: true,
    instructSettings: {},
  },
  overridePayload = {}, // ← сюда кладём { model: '...' } и другие переопределения
);
```

Что происходит внутри (`shared.js:431–488`):

1. `validateProfile(profile)` проверяет, что API профиля поддерживается
   (`openai` или `textgenerationwebui`).
2. Для chat completion берётся пресет прокси по **имени** `profile.proxy` из
   массива `proxies` и подставляются `reverse_proxy` / `proxy_password`.
3. Вызывается `context.ChatCompletionService.processRequest(...)` или
   `context.TextCompletionService.processRequest(...)`.
4. `overridePayload` разворачивается **последним** в payload:
   `shared.js:460` (chat) и `shared.js:478` (text).

### 3.4. Переопределение модели

```js
const context = SillyTavern.getContext();
const service = context.ConnectionManagerRequestService;

const result = await service.sendRequest(
  profileId,
  [{ role: "user", content: "Верни JSON состояния" }],
  512,
  { stream: false, extractData: true, includePreset: true },
  { model: "openai/gpt-4.1-mini" }, // ← модель только для этого вызова
);

console.log(result.content, result.reasoning);
```

Почему это работает: `sendRequest` собирает payload с `model: profile.model`
(`shared.js:448`), а затем добавляет `...overridePayload` (`shared.js:460`).
Свойство, добавленное позже, перезаписывает предыдущее.

**Ловушка №1.** Никогда не передавайте `{ model: undefined }`:

```js
// ПЛОХО: ключ model будет удалён из payload
{ model: modelOverride } // если modelOverride === undefined

// ХОРОШО
const overrides = {};
if (modelOverride) overrides.model = modelOverride;
```

Причина — `ChatCompletionService.createRequestData` удаляет все `undefined`-ключи
(`public/scripts/custom-request.js:444–449`). Если `model` удалить, сервер
получит запрос без модели.

**Ловушка №2.** `profile.model` может быть пустым, если профиль создавался для
провайдера, которому модель не нужна. Тогда переопределение модели — не
обязательное, но и «модели по умолчанию» у профиля нет.

### 3.5. Пресет и порядок применения

Если `includePreset: true`, `processRequest` применяет пресет профиля:
`presetName → getCompletionPresetByName → presetToGeneratePayload`
(`custom-request.js:544–565, 575–606`). Внутри:

```js
const data = await createGenerationParameters(settings, overridePayload.model, "quiet", overridePayload.messages);
return this.createRequestData({ ...payload, ...overridePayload });
```

То есть порядок такой: **настройки ST → пресет профиля → overridePayload**.
Переопределения из пятого аргумента выигрывают у пресета. Это позволяет,
например, задать `temperature: 0.2` только для вызова состояния.

### 3.6. Стриминг

```js
const maybeGenerator = await service.sendRequest(
  profileId,
  messages,
  512,
  { stream: true, extractData: true },
  { model: "..." },
);

if (typeof maybeGenerator === "function") {
  for await (const chunk of maybeGenerator()) {
    // chunk.text — НАКОПЛЕННЫЙ текст, не дельта
    // chunk.state.reasoning — накопленный reasoning
    console.log(chunk.text);
  }
} else {
  // провайдер/путь не дал стрим — вернулся обычный { content, reasoning }
  console.log(maybeGenerator.content);
}
```

`streamData()` в `custom-request.js:506–531` аккумулирует `text += reply`, поэтому
`chunk.text` — это уже весь текст целиком. Прогресс-бар нужно строить на разнице
длин, а не на склейке чанков.

### 3.7. Ошибки

`sendRequest` оборачивает любую ошибку:

```js
throw new Error("API request failed", { cause: error });
```

(`shared.js:489–491`). Поэтому в UI нужно смотреть на `error.cause.message`,
иначе пользователь увидит только «API request failed». В расширении это делает
`describeError()` в `src/llm-client.js`.

### 3.8. Ограничения

- **Connection Manager должен быть включён.** Иначе
  `getSupportedProfiles()` бросает `Connection Manager is not available`
  (`shared.js:530–534`), а `sendRequest` — то же самое (`shared.js:427–429`).
  Проверка — `extensionSettings.disabledExtensions.includes('connection-manager')`.
- **Поддерживаются только `openai` и `textgenerationwebui`**
  (`getAllowedTypes()`, `shared.js:402–407`). Профили Kobold / Horde / Novel не
  подходят — для них нужен отдельный путь.
- **Профиль не хранит URL прокси.** Только имя пресета; URL и пароль лежат в
  `chatCompletionSettings.proxies`.
- **`includeInstruct` по умолчанию `true`** для text completion: сообщения будут
  обёрнуты instruct-шаблоном. Если промпт уже отформатирован — выключите.

### 3.9. Плюсы и минусы

**Плюсы:** профиль несёт всё подключение (источник, endpoint, секрет, пресет,
instruct); не нужно дублировать внутренности ST; работает и для chat, и для text
completion; модель переопределяется на один вызов; стриминг «из коробки».

**Минусы:** зависимость от включённого Connection Manager; нельзя использовать
экзотические API (Kobold/Horde/Novel); при `includePreset: true` в запрос
попадает много настроек пресета, что иногда нежелательно для служебного вызова.

---

## 4. Вариант B: прямой запрос к `/generate`

Полный контроль над payload, но настройки подключения нужно собрать самому.

### 4.1. Chat completion

```js
const context = SillyTavern.getContext();
const settings = context.chatCompletionSettings;

const payload = {
  chat_completion_source: settings.chat_completion_source,
  model: "любая-модель", // ← переопределение модели
  messages: [{ role: "user", content: "..." }],
  max_tokens: 256,
  stream: false,
};

if (settings.chat_completion_source === "custom") {
  payload.custom_url = settings.custom_url;
}
if (settings.reverse_proxy) {
  payload.reverse_proxy = settings.reverse_proxy;
  payload.proxy_password = settings.proxy_password;
}

const response = await fetch("/api/backends/chat-completions/generate", {
  method: "POST",
  headers: context.getRequestHeaders(),
  body: JSON.stringify(payload),
});

const json = await response.json();
if (!response.ok || json.error) {
  throw new Error(json.error?.message ?? `HTTP ${response.status}`);
}

const text = context.extractMessageFromData(json, "openai");
```

- Endpoint и switch по источникам: `src/endpoints/backends/chat-completions.js:2242, 2259`.
- `extractMessageFromData` доступен в контексте (`st-context.js:287`) и умеет
  разбирать ответы разных провайдеров.
- Модель по умолчанию для текущего источника:
  `context.getChatCompletionModel(context.chatCompletionSettings)`
  (`public/scripts/openai.js:1722`).
- `secret_id` можно не передавать: сервер возьмёт активный секрет. Передавать
  нужно только если хотите конкретный сохранённый ключ.

### 4.2. Text completion

```js
const settings = context.textCompletionSettings;
const response = await fetch("/api/backends/text-completions/generate", {
  method: "POST",
  headers: context.getRequestHeaders(),
  body: JSON.stringify({
    api_type: settings.type,
    api_server: settings.api_server,
    model: "любая-модель",
    prompt: "текст промпта",
    max_tokens: 256,
    stream: false,
  }),
});
```

Сервер прокидывает тело почти как есть в бэкенд
(`src/endpoints/backends/text-completions.js:272–334`), поэтому поля должны
соответствовать выбранному `api_type`.

### 4.3. Плюсы и минусы

**Плюсы:** не нужен Connection Manager; полный контроль над payload
(`json_schema`, `stop`, `top_p`, `logit_bias`, ...); понятная отладка.

**Минусы:** нужно самому повторять сборку настроек для каждого источника
(azure-, vertex-, custom-поля); легко потерять `reverse_proxy`/`secret_id`;
нет пресетов и instruct-обвязки; при смене основного API код должен
перестраиваться.

---

## 5. Вариант C: `generateQuietPrompt` / `generateRaw`

Обе функции доступны в контексте (`generateQuietPrompt`,
`generateRaw`) и используют **текущее основное подключение и текущую модель**:
выбрать другую модель для вызова нельзя.

### 5.1. `generateQuietPrompt`

`public/script.js:3084`. Генерация в контексте чата: строится полный промпт
(персонаж, world info, история), а `quietPrompt` добавляется как
post-history-инструкция. Результат не рендерится в чат.

```js
const text = await context.generateQuietPrompt({ quietPrompt: "Обнови состояние сцены" });
```

Подходит, если состояние должно считаться «в стиле» основной генерации, с
макросами и world info, и отдельная модель не нужна.

### 5.2. `generateRaw`

Генерация **без контекста чата**: вы сами передаёте `prompt` (строку или массив
сообщений), опционально `systemPrompt` и `prefill`. Функция сама приводит
запрос к формату текущего API (chat ↔ text, instruct-обвязка).

```js
const text = await context.generateRaw({
  systemPrompt: "Ты обновляешь состояние сцены.",
  prompt: "Верни JSON...",
  prefill: "{",
});
```

Для chat completion поддерживается `jsonSchema` (structured outputs): ответ
вернётся строкой JSON, но **без валидации** — проверять и парсить нужно
самому, и поддерживается это не всеми провайдерами.

### 5.3. Ограничения варианта C

- нельзя выбрать модель: всегда используется основная;
- нельзя выбрать профиль/секрет;
- `generateQuietPrompt` тащит весь контекст и хуки ST, что для короткого
  служебного запроса избыточно и дороже;
- `generateRaw` ближе к тому, что нужно, но модель всё равно не переопределить.

Поэтому для state manager это запасной путь (например, если Connection Manager
выключен), а не основной.

---

## 6. Список моделей для выбора

### 6.1. Единого endpoint нет

Списки моделей отдаются **провайдер-специфично** через `.../status`. Фронтенд
SillyTavern сам наполняет выпадающий список моделей именно так:
`public/scripts/openai.js:4542` (`POST /api/backends/chat-completions/status`),
результат складывается в `model_list` (`openai.js:175`).

### 6.2. Chat completion

`src/endpoints/backends/chat-completions.js:1778`.

Тело запроса собирается из настроек источника; минимально нужны:

```json
{
  "chat_completion_source": "openrouter",
  "secret_id": "id-сохранённого-секрета",
  "custom_url": "https://.../v1",
  "reverse_proxy": "https://...",
  "proxy_password": "..."
}
```

- `secret_id` — необязателен; без него берётся активный секрет.
- `custom_url` нужен для `custom`.
- `reverse_proxy`/`proxy_password` — если используется прокси.
- Azure дополнительно требует `azure_base_url`, `azure_deployment_name`,
  `azure_api_version`.

Ответ при успехе — `{ data: [{ id, name?, context_length?, ... }] }`
(`chat-completions.js:2110`). Ошибка — `{ error: true }` или не-200 статус.
Часть источников (Fireworks, Google AI Studio, Azure, Workers AI) имеет
отдельные ветки и возвращает тот же конверт `{ data }`.

### 6.3. Text completion

`src/endpoints/backends/text-completions.js:100`.

```json
{ "api_type": "ooba", "api_server": "http://127.0.0.1:5000" }
```

Ответ — `{ result, data: [{ id, ... }] }` (`text-completions.js:227`).
Для `ooba`, `tabby` и некоторых других сервер дополнительно уточняет имя
загруженной модели.

### 6.4. Кто список не отдаёт

Для `claude`, `ai21`, `vertexai`, `perplexity`, `zai`, `minimax` в
`/status` нет ветки: запрос уходит в `else` и возвращает 400
(`chat-completions.js:2062–2065`). Фронтенд ST такие источники не валидирует
(`noValidateSources`, `openai.js:4460`) и просто оставляет поле модели ручным.

**Практический вывод:** в UI обязателен свободный ввод модели. Список — это
подсказка, а не единственный способ. В ST-State-Manager используется
`<input list="stsm_model_list">` + `<datalist>`: выбор из списка и ручной id в
одном поле.

### 6.5. Как это делает сам Connection Manager

У профиля нет отдельного динамического списка моделей: `profile.model` — это
снимок, который записывается при создании/обновлении профиля через
slash-команды (`CC_COMMANDS`, `TC_COMMANDS`). Поэтому для «выбрать модель под
конкретный вызов» профиль подходит только как источник подключения, а модель
нужно переопределять в запросе.

---

## 7. Три уровня выбора модели

| Уровень | Где хранится | Область действия | Как менять |
| --- | --- | --- | --- |
| Профиль | `connectionManager.profiles[i].model` | все запросы через профиль | UI Connection Manager / `profile.model = ...` (сохраняется) |
| Запрос | 5-й аргумент `sendRequest` | один вызов | `{ model: "..." }` в `overridePayload` |
| Основное подключение | `chatCompletionSettings.<source>_model` | основная генерация | UI SillyTavern / `getChatCompletionModel()` для чтения |

Для state manager правильный уровень — **запрос**: состояние должно считаться
выбранной моделью, но это не должно менять модель основного чата.

---

## 8. Подводные камни (чек-лист)

1. **`{ model: undefined }` удаляет модель из payload** — собирайте overrides
   условно.
2. **Ошибки обёрнуты**: читайте `error.cause.message`
   (`shared.js:489–491`).
3. **Connection Manager может быть выключен**: `getSupportedProfiles()`
   бросает исключение; проверяйте `disabledExtensions`.
4. **`profile.proxy` — имя пресета, не URL.** Для прямого `/status` URL и
   пароль берите из `chatCompletionSettings.proxies`.
5. **`includePreset` по умолчанию `true`.** Для служебного вызова это может
   принести лишние настройки; при необходимости выключайте.
6. **Пресет применяется до overrides**, поэтому `temperature` в 5-м аргументе
   выигрывает у пресета.
7. **`max_tokens` задаётся отдельным аргументом** `sendRequest`, а не в
   `custom`. Для text completion он превращается в `max_tokens` и
   `max_new_tokens` (`custom-request.js:86–98`).
8. **Стриминговые чанки накопительные**, а не дельты
   (`custom-request.js:506–531`).
9. **Text completion: массив сообщений превращается в строку** внутри
   `processRequest` (`custom-request.js:293–311`); при `includeInstruct: true`
   сообщения оборачиваются instruct-шаблоном.
10. **Не запускайте служебный вызов во время основной генерации**: провайдеры
    ограничивают конкурентные запросы, а UI ST может показать два стрима.
    Планируйте вызов после `GENERATION_ENDED` или по кнопке.
11. **`json_schema`** можно передать через `overridePayload` — сервер
    развернёт схему под источник (`chat-completions.js:2255–2257`), а
    `ChatCompletionService.sendRequest` при `json_schema` вернёт уже
    распарсенный объект в `content` (`custom-request.js:489–493`). Это удобно
    для извлечения состояния, но поддерживается не всеми провайдерами.
12. **Список моделей может быть большим и платным по латентности** (OpenRouter
    отдаёт сотни записей). Кэшируйте его и обновляйте по кнопке.
13. **Не храните ключи в расширении** — только `secret_id`, и то опционально.
14. **`getSupportedProfiles()` фильтрует API** — Kobold/Horde/Novel в списке
    не появятся, это ожидаемо.

---

## 9. Что реализовано в ST-State-Manager

| Возможность | Где |
| --- | --- |
| Профиль + модель на запрос | `src/llm-client.js` → `generate()` → `generateWithProfile()`; overrides собираются условно, `model` не попадает в payload как `undefined` |
| Основное подключение как fallback | `generateWithMainApi()` — только chat completion, с явной ошибкой для остальных API |
| Список моделей | `fetchModels()` → `buildProfileStatusRequest()` / `buildMainStatusRequest()`; нормализация, дедупликация, сортировка |
| Резолв эффективной модели | `resolveModel(profileId, override)` |
| Читаемые ошибки | `describeError()` |
| Настройки | `src/settings.js`, ключ `extension_settings.st_state_manager` |
| Тестовый запрос | `runTestRequest()` + кнопка в `settings.html` |
| Состояние чата | `src/state-store.js`, ключ `chat_metadata.st_state_manager` |

Проверка гипотез на практике: тестовый запрос в панели расширения показывает
`backend`, фактическую модель, задержку и ответ — этого достаточно, чтобы
убедиться, что переопределение модели работает для выбранного профиля.

---

## 10. Полезные ссылки

Локальные исходники (SillyTavern 1.19.0):

- `public/scripts/extensions/shared.js` — `ConnectionManagerRequestService`
- `public/scripts/custom-request.js` — `ChatCompletionService`, `TextCompletionService`
- `public/scripts/openai.js` — `getChatCompletionModel`, `model_list`, `/status`
- `public/scripts/st-context.js` — публичный `getContext()`
- `public/scripts/extensions/connection-manager/index.js` — профили
- `src/endpoints/backends/chat-completions.js` — `/status`, `/generate`
- `src/endpoints/backends/text-completions.js` — `/status`, `/generate`

Upstream (GitHub, ветка `main`):

- <https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/extensions/shared.js>
- <https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/custom-request.js>
- <https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/backends/chat-completions.js>

Документация SillyTavern для разработчиков расширений:

- <https://docs.sillytavern.app/for-contributors/writing-extensions/>

---

## 11. Приложение: минимальные сниппеты

### 11.1. Один вызов через профиль с другой моделью

```js
const context = SillyTavern.getContext();
const result = await context.ConnectionManagerRequestService.sendRequest(
  profileId,
  [{ role: "user", content: prompt }],
  512,
  { stream: false, extractData: true, includePreset: true },
  { model: modelId },
);
console.log(result.content);
```

### 11.2. Список моделей профиля

```js
const context = SillyTavern.getContext();
const profile = context.extensionSettings.connectionManager.profiles.find((p) => p.id === profileId);
const map = context.CONNECT_API_MAP[profile.api];
const proxy = context.chatCompletionSettings.proxies.find((p) => p.name === profile.proxy);

const response = await fetch("/api/backends/chat-completions/status", {
  method: "POST",
  headers: context.getRequestHeaders(),
  body: JSON.stringify({
    chat_completion_source: map.source,
    secret_id: profile["secret-id"],
    custom_url: profile["api-url"],
    reverse_proxy: proxy?.url ?? "",
    proxy_password: proxy?.password ?? "",
  }),
});

const { data = [] } = await response.json();
const ids = data.map((model) => model.id);
```

### 11.3. Тихая генерация текущей моделью (без выбора)

```js
const context = SillyTavern.getContext();
const text = await context.generateQuietPrompt({ quietPrompt: prompt });
```
