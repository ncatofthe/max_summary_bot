# MAX Summary Bot

Demo-ready boundary для summary-бота в MAX. Репозиторий уже разделяет messenger layer и core-processing: `apps/bot-gateway` принимает webhook payloads MAX, нормализует их, ходит во внутренний API и возвращает structured outbound responses без реальной отправки сообщений в production MAX.

## Что уже можно показать

- `/start`, `/help`, `/modes`
- create из plain text, URL и file metadata
- `/status <documentId>`
- `/result <documentId>`
- mode callbacks с `documentId` внутри payload:
  - `summary:mode:detailed`
  - `summary:mode:key-points`
  - `summary:mode:action-items`
  - `summary:length:shorter`
  - `summary:length:longer`

Gateway не отправляет сообщения в MAX по-настоящему. Вместо этого он возвращает structured response, который показывает, что было бы отправлено обратно в чат.

## Ключевые директории

- `apps/bot-gateway` — HTTP gateway и routing decision layer для MAX
- `packages/integrations-max` — нормализованные MAX types, callback payload format и outbound contracts
- `apps/api` — internal API для create/status/summary
- `docs/demo/demo-runbook.md` — пошаговый demo сценарий
- `docs/technical/max-gateway.md` — техническая граница messenger adapter
- `scripts/demo-payloads` — готовые webhook payload examples
- `scripts/smoke-demo.sh` — быстрый curl-based demo

## Установка

```bash
corepack enable
corepack use pnpm@10.33.0
corepack pnpm install
```

## Build и typecheck в gateway-зоне

```bash
corepack pnpm --filter @max-summary/integrations-max --filter @max-summary/bot-gateway build
corepack pnpm --filter @max-summary/integrations-max --filter @max-summary/bot-gateway typecheck
```

## Быстрый запуск demo

Предполагается, что internal API доступен по `http://127.0.0.1:3002`.

Запустить gateway:

```bash
corepack pnpm --filter @max-summary/bot-gateway dev
```

Если internal API живёт по другому адресу:

```bash
INTERNAL_API_BASE_URL=http://host:3002 corepack pnpm --filter @max-summary/bot-gateway dev
```

Запустить smoke demo:

```bash
bash scripts/smoke-demo.sh
```

Если у тебя уже есть `documentId` с готовым summary и ты хочешь гарантированно показать `/result` и callbacks в ready-state:

```bash
DEMO_READY_DOCUMENT_ID=<completed-document-id> bash scripts/smoke-demo.sh
```

## Что лежит в demo payloads

- [start.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/start.json)
- [plain-text.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/plain-text.json)
- [url.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/url.json)
- [file.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/file.json)
- [callback-detailed.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/callback-detailed.json)
- [callback-action-items.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/callback-action-items.json)

## Формат callback payload

```text
max-summary?action=<actionId>&documentId=<documentId>
```

`documentId` зашивается в кнопки сразу после create, поэтому callbacks можно нажимать позже без дополнительного state внутри gateway.

## Поддержанные webhook payloads

- command:
  - `/start`
  - `/help`
  - `/modes`
  - `/status <documentId>`
  - `/result <documentId>`
- plain text
- URL-only message
- file metadata message
- callback button action

## Что пока остаётся stub

- реальный outbound в production MAX;
- webhook auth/signature verification;
- long polling и provider retry logic;
- upload/download flow вложений MAX;
- end-to-end готовность processing stack зависит от sibling services (`apps/api`, `apps/worker`, extractor/summarizer).

Подробности:

- [demo-runbook.md](/Users/hatss/Documents/max_summary_bot/docs/demo/demo-runbook.md)
- [max-gateway.md](/Users/hatss/Documents/max_summary_bot/docs/technical/max-gateway.md)
