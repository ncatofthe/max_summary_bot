# Extractor Service

## Назначение

`apps/extractor-python` отвечает за best-effort extraction без LLM. Его задача — из входа `inline-text`, `url`, `txt`, `docx` или `pdf` получить читаемый текст, нормализовать его и вернуть стабильный JSON-контракт для дальнейшей суммаризации.

## Контракт

### Request

```json
{
  "documentId": "string",
  "sourceType": "pdf|docx|txt|url|inline-text",
  "sourceUri": "string | optional",
  "fileName": "string | optional",
  "mimeType": "string | optional",
  "inlineText": "string | optional",
  "language": "string | optional"
}
```

### Success

```json
{
  "status": "ok",
  "documentId": "string",
  "sourceType": "pdf|docx|txt|url|inline-text",
  "rawText": "string",
  "normalizedText": "string",
  "language": "ru|en|null",
  "pageCount": 12,
  "sections": [
    {
      "heading": "optional",
      "text": "section text",
      "pageStart": 1,
      "pageEnd": 1
    }
  ],
  "warnings": [],
  "metadata": {
    "characterCount": 2048,
    "sectionCount": 8
  }
}
```

### Controlled errors

```json
{
  "status": "error",
  "code": "unsupported-source|download-failed|extract-failed|validation-error",
  "message": "string",
  "warnings": ["string"]
}
```

## Как работает по типам входа

### `inline-text`

- использует `inlineText` как источник;
- чистит пробелы, пустые блоки и разрывы;
- строит секции по абзацам и heading-like блокам.

### `url`

- скачивает страницу через `httpx`;
- пытается вытащить основной текст через `trafilatura`;
- если `trafilatura` не справляется, включает fallback через `BeautifulSoup`;
- возвращает warnings для paywall, low-text-density и plain-text URL.

### `txt`

- поддерживает локальный путь и `http(s)` URL;
- декодирует текст best-effort через `utf-8-sig`, `utf-8`, `utf-16`, `cp1251`, `latin-1`;
- возвращает нормализованный plain text и секции.

### `docx`

- читает документ через `python-docx`;
- сохраняет основной порядок блоков;
- headings попадают в `heading`, простые списки и таблицы flatten'ятся в plain text;
- для таблиц добавляет warning `tables-flattened-to-plain-text`.

### `pdf`

- открывает PDF через `PyMuPDF`;
- извлекает текст page-by-page из text blocks;
- возвращает `pageCount` и page-aware sections;
- если PDF почти пустой или похож на скан, возвращает controlled error без traceback.

## Нормализация текста

Сервис делает лёгкую нормализацию:

- удаляет null bytes и soft hyphen;
- приводит переносы строк к `\n`;
- схлопывает лишние пробелы;
- удаляет слишком длинные цепочки пустых строк;
- собирает обычные строки в абзацы, но оставляет bullets и heading-like строки отдельными блоками.

## Язык

Если язык пришёл в request, сервис его пробрасывает дальше. Иначе используется простая эвристика:

- преобладают кириллические символы -> `ru`
- преобладают латинские символы -> `en`

## Ограничения

- OCR нет;
- image-only PDF не поддерживается;
- сложная табличная или колонночная вёрстка может flatten'иться;
- URL extraction зависит от доступности страницы, HTML-структуры и paywall;
- сервис не занимается entity extraction, classification или semantic reasoning.
