# extractor-python

Best-effort document understanding service для MVP без LLM. Сервис принимает `inline-text`, `url`, `txt`, `docx` и text-based `pdf`, извлекает читаемый текст, нормализует его и возвращает секции, warnings и простые метаданные.

## Что умеет

- `inline-text`: использует `inlineText` как основной источник;
- `url`: скачивает HTML, вытаскивает основной текст через `trafilatura`, при необходимости падает в fallback через `BeautifulSoup`;
- `txt`: читает локальный путь или `http(s)` URL;
- `docx`: вынимает абзацы, заголовки, простые списки и уплощённые таблицы;
- `pdf`: извлекает текст из text-based PDF через `PyMuPDF`, возвращает `pageCount` и page-aware sections;
- synthetic URI вида `max-message://...` и `max-file://...` не валят сервис traceback'ом, а возвращают controlled error.

## Ограничения

- OCR нет;
- сканированные и image-only PDF возвращают controlled error или warning;
- сложная вёрстка DOCX/PDF flatten'ится в plain text;
- URL extraction зависит от доступности страницы, paywall и качества HTML.

## Запуск

```bash
cd apps/extractor-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `POST /extract`

## Контракт `POST /extract`

### Request JSON

```json
{
  "documentId": "doc-123",
  "sourceType": "inline-text",
  "sourceUri": "optional",
  "fileName": "optional",
  "mimeType": "optional",
  "inlineText": "optional",
  "language": "optional"
}
```

### Success JSON

```json
{
  "status": "ok",
  "documentId": "doc-123",
  "sourceType": "inline-text",
  "rawText": "string",
  "normalizedText": "string",
  "language": "ru",
  "sections": [
    {
      "heading": "optional",
      "text": "section text"
    }
  ],
  "warnings": [],
  "metadata": {
    "characterCount": 420,
    "sectionCount": 3
  }
}
```

### Controlled error JSON

```json
{
  "status": "error",
  "code": "validation-error",
  "message": "inlineText is required for sourceType=inline-text.",
  "warnings": []
}
```

## Быстрые проверки

```bash
python3 -m py_compile app/main.py
curl -s http://localhost:8000/healthz
```
