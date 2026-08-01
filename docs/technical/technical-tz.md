# Technical TZ

## 1. Цель документа

Зафиксировать техническую основу MVP-бота для MAX, который принимает документы и ссылки, обрабатывает их асинхронно и возвращает summary. Этот вариант нормализует исходное ТЗ в markdown и служит опорой для следующих агентов.

## 2. Принципы реализации

- простой модульный monorepo без лишней магии;
- Node.js + TypeScript для bot/API/worker;
- Python microservice для extraction;
- BullMQ + Redis для очереди;
- PostgreSQL для метаданных;
- MinIO как S3-compatible storage;
- messenger adapter отделён от core processing;
- на этом шаге допускаются только интерфейсы, contracts и stubs.

## 3. Нормализованный scope текущего этапа

### Делаем сейчас

- monorepo на `pnpm` через `corepack`;
- каркас сервисов `bot-gateway`, `api`, `worker`, `extractor-python`;
- health endpoints `/healthz` и `/readyz`;
- Docker Compose для PostgreSQL, Redis и MinIO;
- доменные контракты и package boundaries;
- markdown-документацию внутри репозитория.

### Осознанно не делаем сейчас

- реальный webhook flow для MAX;
- загрузку и хранение файлов;
- боевой extraction;
- BullMQ workers с подключением к Redis;
- LLM orchestration;
- admin UI;
- боевые таблицы БД и миграции.

## 4. Архитектурная схема

1. `apps/bot-gateway` принимает внешние сообщения от MAX.
2. `apps/api` управляет intake, статусами, контрактами и orchestration.
3. `apps/worker` выполняет асинхронную обработку jobs.
4. `apps/extractor-python` отвечает за extraction из PDF/DOCX/TXT/URL.
5. `packages/summarizer` изолирует summarization и provider abstraction.
6. `packages/storage` инкапсулирует Postgres/Redis/S3 contracts.
7. `packages/integrations-max` отделяет messenger API от доменной логики.

## 5. Рекомендуемый стек

| Слой | Технология | Причина |
| --- | --- | --- |
| Monorepo | Node.js + TypeScript | единый stack для gateway/API/worker |
| Package manager | `pnpm` через `corepack` | лёгкий и предсказуемый workspace |
| HTTP | Fastify | быстрый и простой skeleton без фреймворк-слоя сверху |
| Queue | BullMQ + Redis | достаточно для MVP и retries |
| DB | PostgreSQL | метаданные, jobs, usage |
| Object storage | MinIO / S3 | хранение файлов и артефактов |
| Extraction | Python + FastAPI | удобно для PDF/DOCX/URL parsing |
| Summarization | provider abstraction | чтобы менять LLM без переписывания продукта |

## 6. Репозиторий

```text
apps/
  bot-gateway/
  api/
  worker/
  extractor-python/
packages/
  core/
  shared-types/
  summarizer/
  integrations-max/
  storage/
  observability/
infra/
docs/
  product/
  technical/
```

## 7. Доменные контракты

В `packages/shared-types` фиксируются следующие базовые сущности:

- `Document`
- `Job`
- `SummaryMode`
- `JobStatus`
- `ExtractResult`
- `SummarizationRequest`
- `SummarizationResult`

Это единая точка правды для контрактов между gateway, API, worker, extractor и summarizer.

## 8. Нормализованные job statuses

Из исходных документов были сведены в один набор следующие статусы:

- `created`
- `queued`
- `validating`
- `extracting`
- `chunking`
- `summarizing`
- `formatting`
- `sending`
- `completed`
- `failed`
- `expired`

На этом шаге статусы существуют как типы и заглушки ответов, без настоящих переходов между состояниями.

## 9. Базовый pipeline в целевом состоянии

1. Приём сообщения или файла.
2. Создание `Document` и `Job`.
3. Проверка формата, размера, MIME и limit policy.
4. Извлечение текста в Python сервисе.
5. Нормализация и структурирование текста.
6. Chunking и подготовка контекста.
7. Summarization map-reduce.
8. Enrichment: цифры, риски, action items.
9. Post-processing и форматирование ответа.
10. Отправка результата обратно в MAX и сохранение артефактов.

## 10. Внутренние API, которые зарезервированы под развитие

| Метод | Путь | Назначение |
| --- | --- | --- |
| `POST` | `/max/webhook` | приём событий от MAX |
| `POST` | `/documents` | создать документ и job |
| `GET` | `/documents/:id/status` | статус обработки |
| `GET` | `/documents/:id/summary` | готовый summary |
| `POST` | `/documents/:id/ask` | Q&A по документу, позже |
| `GET` | `/healthz` | liveness |
| `GET` | `/readyz` | readiness |

На текущем этапе реализованы только health endpoints и placeholder routes без боевой логики.

## 11. Data model на будущее

Минимально ожидаются следующие сущности:

- `users`
- `chats`
- `documents`
- `jobs`
- `document_chunks`
- `summaries`
- `events`
- `usage_events`

DDL, миграции и реальные репозитории пока не включены.

## 12. Интеграция с MAX

Наблюдения из исходного ТЗ, которые важно сохранить:

- dev-режим может использовать long polling;
- production должен использовать webhook;
- токен передаётся через заголовок `Authorization`;
- стоит учитывать лимиты платформы по частоте запросов;
- вложения проходят через upload flow платформы MAX.

Сама интеграция пока сознательно изолирована в `packages/integrations-max` и не подключена к runtime.

## 13. Security и privacy

- не хранить секреты в коде;
- использовать приватный bucket или signed URLs;
- ограничить TTL исходных файлов;
- не логировать полный текст документов;
- добавить лимиты по размеру и числу jobs на пользователя.

## 14. Observability

Минимальный набор, который должен появиться на следующих этапах:

- time to first response;
- time to final summary;
- extract success rate;
- summary regeneration rate;
- cache hit rate;
- cost per job;
- top failure codes.

На текущем шаге в репо есть только базовый logger utility и health endpoints.

## 15. Критерии приёмки foundation

- репозиторий собирается как каркас;
- структура понятна для следующих агентов;
- сервисы имеют `/healthz` и `/readyz`;
- инфраструктура поднимается через Docker Compose;
- документация лежит внутри репозитория;
- нет привязки core processing к конкретному messenger provider.
