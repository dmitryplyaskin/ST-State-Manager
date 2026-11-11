# ST-State-Manager

A SillyTavern extension scaffold for managing the **state of a roleplay chat**
(facts, flags, character stats, world variables) with the help of a **separate
model call** that can use its own connection profile and its own model.

> **Status: 0.1.0 — scaffold.** The extension already loads, renders settings,
> lists connection profiles and models, sends a test request and stores a
> per-chat state document. The state extraction prompt and prompt injection are
> the next step (see [Roadmap](#roadmap)).

- [English](#english)
- [Русский](#russian)

---

<a id="english"></a>

## English

### What it is

ST-State-Manager is meant to keep a structured snapshot of the current scene
next to the chat: who is where, what changed, which flags are set. The snapshot
lives in the chat metadata, is updated by a model call that is **independent
from the main generation**, and can later be injected back into the prompt.

The extension is intentionally split into small modules, so the state logic can
grow without touching the UI or the request layer.

### What works now

- Extension loads and registers its event hooks.
- Settings panel in **Extensions → ST-State-Manager**.
- **Connection profile selector** (Connection Manager profiles that support chat
  or text completion).
- **Model override** per request: pick a model from the fetched list or type any
  model id. An empty field keeps the profile/current model.
- Model list is loaded from the provider through SillyTavern's `/status`
  endpoint; when a provider cannot list models, the field stays free-form.
- **Test request** button — sends one message with the selected profile and
  model, shows the effective backend, model, latency and the answer.
- Per-chat state document in `chat_metadata.st_state_manager` with revision
  counter, JSON preview and reset button.

### Requirements

- SillyTavern **1.19.x** (developed and verified against `1.19.0`).
- The built-in **Connection Manager** extension is recommended. Without it only
  the main SillyTavern connection (chat completion APIs) is available.
- The chat completion or text completion API must be configured in SillyTavern
  itself — the extension never stores API keys.

### Installation

Copy the folder into the user's extensions directory:

```
data/default-user/extensions/ST-State-Manager/
```

or install it through **Extensions → Install extension** with the repository URL
once the repository exists.

> The folder name **must stay `ST-State-Manager`**: the settings template is
> loaded as `third-party/ST-State-Manager/settings.html`.

Reload the page and open **Extensions → ST-State-Manager**.

### Settings

| Setting | Meaning |
| --- | --- |
| Enable extension | Master switch; when off no model calls are made. |
| Connection profile | Profile used for the call. `Main SillyTavern connection` = the current chat completion connection. |
| Model override | Model id for this extension's calls. Empty = the profile's / current model. |
| Max tokens | Upper bound for one call (16–8192). |
| Temperature | Sampling temperature; empty = keep the profile preset value. |
| Apply the profile's generation preset | When on, the profile's chat completion preset is applied before the overrides. |
| Stream responses | Reserved for streaming consumers; the test request is always non-streaming. |
| Test request | Sends one message and prints backend, model, latency and content. |
| Current chat state | JSON preview of `chat_metadata.st_state_manager`. |

### Architecture

```
ST-State-Manager/
├── manifest.json          # extension manifest (display name, load order, entry points)
├── index.js               # entry point: settings, hooks, panel initialization
├── settings.html          # settings panel template
├── style.css              # panel styles
├── RESEARCH.md            # how custom model calls and model selection work in ST
├── dev/
│   └── smoke-test.mjs     # Node smoke test for the request/state logic
└── src/
    ├── settings.js        # defaults + extension_settings persistence
    ├── llm-client.js      # profile/model resolution, model list, generation
    ├── state-store.js     # per-chat state document (chat_metadata)
    └── ui.js              # settings panel wiring
```

`RESEARCH.md` documents how custom model calls and model selection work in
SillyTavern 1.19, with references to the exact source files.

### Development

No build step is required: the extension is plain ES modules loaded by
SillyTavern. To check the request/state logic without starting SillyTavern:

```bash
node dev/smoke-test.mjs
```

The smoke test runs against a stubbed `SillyTavern` context and covers settings
defaults, model resolution, `overridePayload` construction (including the
"no `model: undefined`" rule), model list request bodies, error formatting and
the state document lifecycle.

### Roadmap

1. State schema and validation (JSON Schema or a hand-written validator).
2. Extraction prompt: chat tail → model call → validated patch → `updateState()`.
3. Optional automatic update on `MESSAGE_RECEIVED` / `GENERATION_ENDED`.
4. Prompt injection of the current state (`setExtensionPrompt`).
5. Manual editor for the state JSON and per-chat presets.

### License

MIT — see [LICENSE](LICENSE).

### Author

Dmitry Plyaskin

---

<a id="russian"></a>

## Русский

### Что это

ST-State-Manager — расширение для SillyTavern, которое ведёт **состояние
ролевого чата** (факты, флаги, характеристики персонажей, переменные мира) и
обновляет его **отдельным вызовом модели**, независимым от основной генерации.
Вызов может идти через собственный профиль подключения и собственную модель.

> **Статус: 0.1.0 — каркас.** Расширение уже загружается, рисует настройки,
> получает список профилей и моделей, отправляет тестовый запрос и хранит
> документ состояния для каждого чата. Промпт извлечения состояния и вставка
> состояния в промпт — следующие шаги (см. [План](#план)).

### Что уже работает

- Загрузка расширения и регистрация обработчиков событий.
- Панель настроек в **Extensions → ST-State-Manager**.
- **Выбор профиля подключения** (профили Connection Manager, поддерживающие
  chat completion или text completion).
- **Переопределение модели** для запроса: выбрать из загруженного списка или
  вписать любой id. Пустое поле — модель профиля/текущая модель.
- Список моделей запрашивается у провайдера через endpoint `/status`; если
  провайдер не умеет отдавать список, поле остаётся свободным для ввода.
- Кнопка **Test request** — отправляет одно сообщение с выбранными профилем и
  моделью и показывает backend, модель, задержку и ответ.
- Документ состояния в `chat_metadata.st_state_manager` со счётчиком ревизий,
  JSON-превью и кнопкой сброса.

### Требования

- SillyTavern **1.19.x** (проверено на `1.19.0`).
- Желательно включённое встроенное расширение **Connection Manager**. Без него
  доступно только основное подключение SillyTavern (chat completion).
- API должно быть настроено в самом SillyTavern — расширение не хранит ключи.

### Установка

Скопируйте папку в каталог расширений пользователя:

```
data/default-user/extensions/ST-State-Manager/
```

или установите через **Extensions → Install extension** по URL репозитория,
когда он появится.

> Имя папки **должно остаться `ST-State-Manager`**: шаблон настроек грузится как
> `third-party/ST-State-Manager/settings.html`.

Перезагрузите страницу и откройте **Extensions → ST-State-Manager**.

### Настройки

| Настройка | Значение |
| --- | --- |
| Enable extension | Главный переключатель; когда выключен, запросы к модели не выполняются. |
| Connection profile | Профиль для запроса. `Main SillyTavern connection` — текущее chat completion подключение. |
| Model override | Id модели для запросов расширения. Пусто — модель профиля/текущая. |
| Max tokens | Ограничение на один запрос (16–8192). |
| Temperature | Температура; пусто — значение из пресета профиля. |
| Apply the profile's generation preset | Применять пресет чата профиля перед переопределениями. |
| Stream responses | Зарезервировано для потоковых потребителей; тестовый запрос всегда без стрима. |
| Test request | Один запрос: backend, модель, задержка, ответ. |
| Current chat state | JSON-превью `chat_metadata.st_state_manager`. |

### Архитектура

```
ST-State-Manager/
├── manifest.json          # манифест расширения
├── index.js               # точка входа: настройки, хуки, панель
├── settings.html          # шаблон панели настроек
├── style.css              # стили панели
├── RESEARCH.md            # как устроены кастомные вызовы и выбор модели
├── dev/
│   └── smoke-test.mjs     # смоук-тест логики запросов и состояния
└── src/
    ├── settings.js        # значения по умолчанию и хранение в extension_settings
    ├── llm-client.js      # профили, модели, вызов модели
    ├── state-store.js     # документ состояния в chat_metadata
    └── ui.js              # связывание панели настроек
```

В `RESEARCH.md` разобрано, как в SillyTavern 1.19 устроены кастомные вызовы
модели и выбор модели, со ссылками на конкретные файлы исходников.

### Разработка

Сборка не нужна: расширение — это обычные ES-модули, которые загружает
SillyTavern. Проверить логику запросов и состояния без запуска SillyTavern:

```bash
node dev/smoke-test.mjs
```

Смоук-тест работает на заглушке контекста `SillyTavern` и проверяет значения по
умолчанию, резолв модели, сборку `overridePayload` (включая правило «никакого
`model: undefined`»), тела запросов за списком моделей, форматирование ошибок и
жизненный цикл документа состояния.

### План

1. Схема состояния и валидация (JSON Schema или ручной валидатор).
2. Промпт извлечения: хвост чата → вызов модели → проверенный патч → `updateState()`.
3. Опциональное автообновление на `MESSAGE_RECEIVED` / `GENERATION_ENDED`.
4. Вставка состояния в промпт (`setExtensionPrompt`).
5. Ручной редактор JSON состояния и пресеты для чата.

### Лицензия

MIT — см. [LICENSE](LICENSE).

### Автор

Dmitry Plyaskin
