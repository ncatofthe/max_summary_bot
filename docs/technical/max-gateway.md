# MAX Gateway

## Назначение

`apps/bot-gateway` и `packages/integrations-max` образуют demo-ready messenger boundary для MAX. Этот слой:

- принимает raw webhook payload;
- нормализует update в стабильный envelope;
- принимает routing decision;
- обращается к internal API (`POST /documents`, `GET /documents/:id/status`, `GET /documents/:id/summary`);
- формирует structured outbound messages и callbacks без реальной отправки в MAX.

Главная идея: MAX-специфика живёт на boundary, а core-processing остаётся отдельно.

## Поддержанные inbound update types

### Commands

- `/start`
- `/help`
- `/modes`
- `/status <documentId>`
- `/result <documentId>`

### Messages

- `plain-text`
- `url-message`
- `file-message`
  - metadata-only: `fileName`, `mimeType`, `sizeBytes`, `sourceUrl`, inferred `sourceType`

### Callbacks

- `callback-button` с payload формата:

```text
max-summary?action=<actionId>&documentId=<documentId>
```

Поддержанные `actionId`:

- `summary:mode:detailed`
- `summary:mode:key-points`
- `summary:mode:action-items`
- `summary:length:shorter`
- `summary:length:longer`

## Normalized contracts

`packages/integrations-max` фиксирует:

- нормализованные inbound events;
- parser/normalizer raw webhook payloads;
- parser callback payloads;
- builder для outbound buttons с `documentId`;
- outbound message contracts:
  - `message`
  - `service-status`
  - `summary-response`

## Routing rules

### Local responses

- `/start` -> onboarding text
- `/help` -> ограничения и поддерживаемые форматы
- `/modes` -> описание режимов summary
- неизвестная команда -> unsupported response
- некорректная команда без `documentId` -> usage response

### Internal API calls

- `plain-text` -> `POST /documents`
- `url-message` -> `POST /documents`
- `file-message` -> `POST /documents`
- `/status <documentId>` -> `GET /documents/:id/status`
- `/result <documentId>` -> `GET /documents/:id/summary`
- `callback-button` -> `GET /documents/:id/summary`

## Поведение create/status/result/callback flow

### Create

После `POST /documents` gateway возвращает:

- `service-status` со статусом `accepted`
- `documentId`
- summary buttons с `documentId` внутри callback payload

### Status

`/status <documentId>` мапит job status во внешний user-facing status:

- `created`, `queued` -> `accepted`
- intermediate statuses -> `processing`
- `completed` -> `completed`
- `failed`, `expired` -> `error`

### Result

`/result <documentId>` и callbacks идут в `GET /documents/:id/summary`:

- `200` -> gateway рендерит `summary-response`
- `202` -> gateway рендерит `processing`
- `404` -> gateway рендерит controlled `error`
- timeout/network -> gateway рендерит `temporarily-unavailable`

### Mode callbacks

При готовом summary gateway умеет отрисовать:

- detailed
- key points
- action items
- shorter
- longer

Это чистый boundary-level rendering. Никакой дополнительной бизнес-логики в core-processing сюда не переносится.

## Bridge к существующему `/documents`

`apps/api` принимает только:

- `sourceType`
- `sourceUri`
- `fileName`
- `mode`

Из-за этого gateway делает mapping:

- `plain-text` -> `sourceType: "inline-text"` и synthetic `sourceUri` вида `max-message://...`
- `url-message` -> `sourceType: "url"` и реальный URL в `sourceUri`
- `file-message` -> inferred `sourceType` (`pdf` / `docx` / `txt`) и `sourceUrl`, если он есть; иначе synthetic `max-file://...`

Это позволяет не менять контракт internal API и держать messenger-specific данные вне `apps/api`.

## Controlled failures

### Normalization errors

Если webhook payload не распознан, normalizer возвращает controlled error result c кодом:

- `invalid-payload`
- `unsupported-update`
- `unsupported-message`
- `missing-chat-context`

### Internal API errors

Internal API client различает:

- `200`
- `202`
- `404`
- `timeout`
- `network`
- `bad-status`
- `invalid-response`

Gateway на этих состояниях всегда возвращает structured response, а не raw fetch exception.

## Boundary separation

- `packages/integrations-max` знает только про MAX payloads, callback payload format и outbound contracts
- `apps/bot-gateway` знает только про webhook handling, renderers и HTTP client к internal API
- `apps/api` не знает ничего про MAX commands, callback buttons или button payload format

Это оставляет возможность заменить messenger channel без переписывания intake pipeline.

## Что пока остаётся stub

- реальная outbound delivery в MAX;
- provider auth/signature validation;
- long polling flow;
- upload/download flow вложений MAX;
- delivery receipts и message edits;
- автоматический push результата в чат без повторного webhook/callback.
