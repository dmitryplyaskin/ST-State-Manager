# ST-State-Manager

A SillyTavern extension that tracks the state of a roleplay scene using an independent model request and supplies that state to the main model.

**Version 0.4.0.** Plain browser ES modules; no build step. Developed against SillyTavern 1.19.0.

## English

### Getting started

1. Install this folder as `data/default-user/extensions/ST-State-Manager/`, or install from `https://github.com/dmitryplyaskin/ST-State-Manager` through Extensions. Keep the folder name `ST-State-Manager`.
2. Reload SillyTavern. **Extensions → ST-State-Manager** contains only the master switch.
3. Open the database icon in the top bar. Its **Settings** tab contains the connection profile, model, scheduling, injection and generation limits. The extension uses SillyTavern's existing credentials; it does not store API keys.
4. Open a chat and click **Update now** in the workspace toolbar. **State** shows the original response without translating keys or inventing a field layout; **History** provides a revision list and restore. **Requests** shows the last ten attempts in this chat, including expanded messages, generation parameters, the response, reasoning and API errors. **Prompt** holds the extraction template and number of messages to read, with an expanded editor and confirmation before replacing a custom prompt.
5. Enable **Automatic updates** in the workspace toolbar when ready. Automatic updates are off by default. The workspace uses SillyTavern's drawer geometry and close behavior, supports pinning, and integrates with Moving UI when enabled in SillyTavern.

### State updates

The worker reads the configured number of recent non-system chat messages, the current state and the retained revision history. It sends a separate, non-streaming request. It never creates a roleplay message or starts the main generation.

- **After:** update after the main model's response finishes.
- **Before:** update after sending the user message; the main generation waits for the worker to finish or fail.
- **Frequency:** count new user messages. Assistant messages and swipes do not advance this counter. The counter is stored per chat and is consumed when an automatic request starts.
- **Swipes:** when automatic updates and the swipe option are enabled, selecting an existing swipe updates immediately. A new swipe or regenerated reply is read after generation finishes, independently of frequency.
- **Manual:** use the drawer button, the chat menu's **Update scene state**, or `/state_update`. Manual requests do not change the frequency counter. `/state_show` opens the state viewer and returns the state text to slash pipelines.

The prompt template supports `{{state}}`, `{{last_messages}}`, `{{history}}` (newest first), `{{chat_name}}` and `{{char_name}}`. The prompt defines the output format: plain text, Markdown, JSON, XML or any other text. Every nonempty response is accepted; an explicit API token-limit finish reason leaves the previous state intact. The original response, including whitespace, is used for display, copying, future prompts and injection. Complete JSON objects and arrays also remain available as structured `data` to integrations. Existing object states stay readable. Model text is never executed as HTML.

The bundled prompt requests concise text in the chat's language and uses only the current state and recent messages. A saved template is migrated only if it exactly matches the old bundled JSON template; edited templates are preserved. Retained history is sent only when the template includes `{{history}}`. **Preview request** shows the expanded prompt without calling a model.

The **Requests** journal retains the last ten attempts in `chat_metadata.st_state_manager_requests`, independently of revision history. It includes connection checks, failures and cancellations, and survives reloads. Chat-completion entries record the prepared SillyTavern request body after preset application and the full API response. Text-completion profiles show service inputs; their final instruct formatting is performed by SillyTavern. Credentials and headers are redacted before storage. Past requests made before this journal existed cannot be reconstructed. Max tokens defaults to 2048 for new installations; existing limits are preserved.

There are no automatic retries. Concurrent triggers are skipped. Requests can be cancelled from the drawer and time out after 120 seconds. Switching chats, editing messages, changing swipes, resetting/restoring state, or disabling the extension invalidates an in-flight result. Starting a new main generation also cancels an older worker. Manual updates during a main response are skipped.

Disabling the extension cancels its pending worker, connection check and model-list requests, clears its prompt injection, removes its drawer, top-bar button, chat-menu action and slash commands, and detaches its chat and connection listeners. A disabled startup creates only the master switch. Re-enabling restores the interface and processing without duplicates; saved settings, state and history are preserved.

### Prompt injection and history

The extension maintains one `setExtensionPrompt` entry. Choose before/after the story string or in chat history. Role and depth apply to in-chat placement; depth 0 is the end of the context. The current state is synchronized on writes, chat changes and injection-setting changes; reset/disable removes it from the prompt.

For chat completion, user/assistant state blocks can be merged into an adjacent message of the same role without altering chat messages, tool calls, or other extensions' blocks. The API's own prompt processing can still merge messages even if this option is off. Text completion uses SillyTavern's normal injection formatting.

State lives in `chat_metadata.st_state_manager`:

```json
{
  "version": 1,
  "revision": 1,
  "updatedAt": 0,
  "data": {},
  "trigger": "manual",
  "history": []
}
```

`history` holds **previous** revisions, not a duplicate of the current revision. The default retention is 50 (0 disables retention); the limit applies on the next write. Restoring a snapshot creates a new revision and preserves the former current state in history. Optional `text` preserves the exact model response while `data` can contain text, an object or an array. Old documents without history remain readable. The frequency counter is `chat_metadata.st_state_manager_counter`. State and history travel with the chat file. Reset removes state, history and the counter after confirmation.

### Connections

Connection Manager profiles support chat completion and text completion. Without a profile, only the current chat completion connection is supported. Profile model overrides apply to one request and do not change the profile. A missing profile causes an error and is never silently replaced with the main connection. Model listing is best-effort; free-form model IDs remain available. Worker calls request one completion and disable model fallback.

OpenRouter routing is resolved independently of the generation-preset switch. For the active profile, the visible provider selection and fallback/quantization settings override an outdated saved preset. The extension remembers these settings per profile so its worker can keep using them after the main connection switches. For an unseen, inactive profile it reads that profile's saved preset, with explicit routing defaults to prevent another profile's provider from leaking into the request. Changing the profile's preset invalidates an old routing snapshot. The panel displays the effective restrictions and their source; the connection check reports the actual provider and request ID returned by OpenRouter. A provider's display in the selector alone does not prove that an old saved preset contains it.

### Development

```sh
node dev/smoke-test.mjs
node dev/state-manager-test.mjs
node dev/provider-routing-test.mjs
node dev/request-log-test.mjs
```

The first suite checks connection/model resolution, request payloads, settings and basic state storage. The second uses an async event-emitter stub to check extraction, parsing, history, frequency, streaming/non-streaming event order, swipes, cancellation, stale-result rejection and prompt injection/merging. The routing suite covers the empty-preset regression, independent profile switching, fallback restrictions and actual-provider metadata. The journal suite covers prepared payloads, redaction, retention, failures, cancellation, reloads and raw response formats. No test makes a network request.

Manual verification: choose a low-cost test profile; update state; send a turn in after mode; send another in before mode; select/generate a swipe; browse and restore a revision; try `/state_show` and `/state_update`; reload and verify metadata persistence. Inspect the main prompt to verify injection. Do not assume a stubbed test proves provider compatibility.

```text
index.js                 initialization and lifecycle hooks
settings.html            minimal Extensions entry
panel.html, style.css    side workspace template and styles
src/settings.js          defaults, normalization and subscriptions
src/llm-client.js        profiles, model listing and independent requests
src/state-store.js       per-chat snapshots, history and rollback
src/worker.js            extraction, cancellation and event scheduling
src/injector.js          extension prompt and same-role merging
src/panel.js             chat drawer, history, menu and slash commands
src/panel-settings.js    working settings, provider routing and connection check
src/state-view.js        original text display without schema interpretation
src/request-log.js       per-chat request/response journal and credential redaction
src/ui.js                master switch and drawer lifecycle
src/runtime.js           enabled-only chat hooks and cleanup
RESEARCH.md              installed SillyTavern API research
```

## Русский

Расширение ведёт состояние ролевой сцены: расположение персонажей, одежду, предметы и установленные факты. Отдельная модель обновляет состояние по сообщениям чата; результат подставляется в контекст основной модели.

### Начало работы

1. Перезагрузите Таверну. В **Extensions → ST-State-Manager** находится только переключатель включения расширения.
2. Откройте иконку базы данных сверху. Во вкладке **Настройки** выберите профиль подключения и проверьте модель и провайдера. Там же настраиваются частота, свайпы, вставка состояния и лимиты.
3. В открытом чате нажмите **Обновить**. Во вкладке **Состояние** показан исходный текст ответа без автоперевода полей и навязанной структуры. **История** содержит ревизии с просмотром и восстановлением. **Запросы** — последние 10 обращений этого чата: отправленные сообщения с подставленными данными, параметры после применения пресета, ответ, рассуждения и ошибки. **Промпт** — шаблон и число сообщений для анализа; предпросмотр не вызывает модель.
4. Для автоматической работы включите **Автообновление** вверху панели. По умолчанию оно выключено. Панель использует штатное открытие/закрытие Таверны, закрепление и механизм Moving UI для перемещения и изменения размеров.

### Поведение

- Режим **After** обновляет состояние после ответа основной модели. Режим **Before** ждёт воркер до основного запроса.
- Частота считается по новым сообщениям пользователя. Свайпы и сообщения ассистента счётчик не меняют; ручное обновление его тоже не сбрасывает.
- При включённой автоматике и обработке свайпов новый вариант читается после окончания генерации, существующий — после выбора. Частота к свайпам не применяется.
- Промпт редактируется; доступны `{{state}}`, `{{last_messages}}`, `{{history}}`, `{{chat_name}}`, `{{char_name}}`.
- Формат задаёт промпт: текст, Markdown, JSON, XML или другой. Принимается любой непустой ответ. Исходный текст, включая пробелы, используется для показа, копирования и вставки в контекст. Если API явно сообщает об обрезке по лимиту токенов, прежнее состояние сохраняется. Полные JSON-объекты и массивы дополнительно доступны через `data`.
- Встроенный промпт запрашивает краткий текст на языке чата и больше не отправляет историю ревизий по умолчанию. Пользовательские шаблоны сохраняются; замена применяется только к точной копии старого встроенного шаблона. Переменная `{{history}}` остаётся доступной.
- Журнал запросов сохраняется вместе с чатом отдельно от истории состояния. Ключи, пароли и заголовки скрываются до записи. Для text completion показаны входные параметры сервиса, окончательный instruct-промпт формирует Таверна. Запросы, сделанные до появления журнала, восстановить нельзя.
- Параллельные обновления пропускаются, автоматических повторов нет. Есть отмена и тайм-аут 120 секунд. Смена чата, изменения сообщений/свайпов, сброс, откат и отключение расширения защищены от запоздалого ответа воркера.
- Настраиваются позиция вставки состояния, роль, глубина и склейка с соседней репликой той же роли. Склейка расширения работает для chat completion; дополнительная обработка провайдера может склеить сообщения независимо от этого переключателя.
- История хранит предыдущие ревизии, по умолчанию до 50; лимит применяется при записи. Откат создаёт новую ревизию. Состояние, история и счётчик сохраняются вместе с чатом.
- Ручной запуск доступен из панели, меню чата и `/state_update`. `/state_show` показывает состояние.
- Выключение отменяет текущие запросы расширения, убирает вставку в промпт, панель, её кнопку, пункт меню чата и команды, снимает обработчики событий. При выключенном запуске создаётся только переключатель. Повторное включение восстанавливает работу без дубликатов; настройки, состояние и история сохраняются.

OpenRouter: выбранный провайдер передаётся отдельно от параметров генерации. Актуальный выбор активного профиля имеет приоритет над устаревшим пресетом и запоминается для независимых запросов расширения. Для другого профиля без сохранённого выбора читается его собственный пресет. В панели видны эффективные ограничения; **Проверить подключение** показывает фактического провайдера и ID запроса из ответа OpenRouter. Это также работает при отключённых параметрах пресета.

Проверки без запросов к API: `node dev/smoke-test.mjs`, `node dev/state-manager-test.mjs` , `node dev/provider-routing-test.mjs` и `node dev/request-log-test.mjs`.

MIT. Author: Dmitry Plyaskin.
