# Demo Runbook

## Что показывает demo

`apps/bot-gateway` уже умеет полный structured MAX boundary flow:

- `/start`
- `/help`
- `/modes`
- create из `plain-text`, `url-message`, `file-message`
- `/status <documentId>`
- `/result <documentId>`
- mode callbacks с `documentId` внутри payload

Gateway не делает реальные outbound-вызовы в MAX. Вместо этого он возвращает structured response, который показывает, что именно было бы отправлено обратно в чат.

## Что нужно поднять

Минимально:

1. internal API на `http://127.0.0.1:3002`
2. `apps/bot-gateway` на `http://127.0.0.1:3001`

При live demo желательно, чтобы worker/extractor/summarizer stack тоже был поднят, тогда `/result` и callbacks смогут дойти до готового summary.

## Быстрый запуск

Установить зависимости:

```bash
corepack enable
corepack use pnpm@10.33.0
corepack pnpm install
```

Собрать gateway-зону:

```bash
corepack pnpm --filter @max-summary/integrations-max --filter @max-summary/bot-gateway build
corepack pnpm --filter @max-summary/integrations-max --filter @max-summary/bot-gateway typecheck
```

Запустить gateway:

```bash
corepack pnpm --filter @max-summary/bot-gateway dev
```

Если internal API доступен не на `127.0.0.1:3002`, задай:

```bash
INTERNAL_API_BASE_URL=http://host:3002 corepack pnpm --filter @max-summary/bot-gateway dev
```

## One-command demo

```bash
bash scripts/smoke-demo.sh
```

Скрипт показывает:

1. `/start`
2. plain-text create
3. `/status <documentId>`
4. `/result <documentId>`
5. callback `detailed`
6. callback `action-items`

## Demo с готовым summary

Свежесозданный документ может ещё обрабатываться. Если хочешь гарантированно показать `ready summary` и mode callbacks, передай `documentId`, у которого summary уже доступен:

```bash
DEMO_READY_DOCUMENT_ID=<completed-document-id> bash scripts/smoke-demo.sh
```

Тогда create/status останутся live, а `/result` и callbacks будут бить в уже готовый документ.

## Payload files

- [start.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/start.json)
- [plain-text.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/plain-text.json)
- [url.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/url.json)
- [file.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/file.json)
- [callback-detailed.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/callback-detailed.json)
- [callback-action-items.json](/Users/hatss/Documents/max_summary_bot/scripts/demo-payloads/callback-action-items.json)

В callback payload files используется placeholder `__DOCUMENT_ID__`. `smoke-demo.sh` заменяет его автоматически.

## Поддержанные callback payloads

Формат:

```text
max-summary?action=<actionId>&documentId=<documentId>
```

Поддержанные `actionId`:

- `summary:mode:detailed`
- `summary:mode:key-points`
- `summary:mode:action-items`
- `summary:length:shorter`
- `summary:length:longer`

## Что пока остаётся stub

- реальная доставка outbound messages в MAX;
- webhook auth/signature validation;
- upload/download flow вложений MAX;
- long polling / provider retries / delivery receipts;
- auto-refresh готового результата внутри самого gateway без повторного webhook.
