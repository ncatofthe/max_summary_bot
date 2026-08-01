from __future__ import annotations

import io
import os
import re
from pathlib import Path
from typing import Any, Iterable, Literal
from urllib.parse import urlparse

import fitz
import httpx
import trafilatura
from bs4 import BeautifulSoup
from docx import Document as DocxDocument
from docx.document import Document as _DocumentType
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table, _Cell, _Row
from docx.text.paragraph import Paragraph
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

SOURCE_TYPES = {"pdf", "docx", "txt", "url", "inline-text"}
HTTP_TIMEOUT = httpx.Timeout(15.0, connect=10.0)
BLOCK_SEPARATOR = "\n\n"
DOWNLOAD_HEADERS = {
    "User-Agent": "max-summary-bot-extractor/0.1 (+https://max.local)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
}
PAYWALL_MARKERS = (
    "subscribe to continue",
    "subscription required",
    "sign in to continue",
    "register to continue",
    "subscribe now",
    "оформите подписку",
    "подпишитесь",
    "доступ только по подписке",
    "войдите, чтобы продолжить",
)
RUSSIAN_CHARS_RE = re.compile(r"[А-Яа-яЁё]")
LATIN_CHARS_RE = re.compile(r"[A-Za-z]")
TOKEN_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+(?:[-'][A-Za-zА-Яа-яЁё0-9]+)?")
LIST_LINE_RE = re.compile(r"^(\s*[-*•]\s+|\s*\d+[.)]\s+)")
HEADING_LINE_RE = re.compile(r"^[A-ZА-ЯЁ0-9][^.!?]{0,100}$")
SYNTHETIC_SCHEMES = {"max-message", "max-file"}


class ExtractRequest(BaseModel):
    documentId: str = Field(min_length=1)
    sourceType: Literal["pdf", "docx", "txt", "url", "inline-text"]
    sourceUri: str | None = None
    fileName: str | None = None
    mimeType: str | None = None
    inlineText: str | None = None
    language: str | None = None

    model_config = ConfigDict(extra="ignore")


class ExtractSection(BaseModel):
    heading: str | None = None
    text: str
    pageStart: int | None = None
    pageEnd: int | None = None


class ControlledExtractionError(Exception):
    def __init__(
        self,
        code: Literal[
            "unsupported-source",
            "download-failed",
            "extract-failed",
            "validation-error",
        ],
        message: str,
        warnings: list[str] | None = None,
        status_code: int = 400,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.warnings = warnings or []
        self.status_code = status_code


app = FastAPI(
    title="extractor-python",
    version="0.2.0",
    summary="Best-effort extraction service for MAX Summary Bot",
)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "service": "extractor-python",
        "status": "ok",
        "message": "Best-effort extraction is enabled for inline-text, url, txt, docx and text-based pdf.",
    }


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", "service": "extractor-python"}


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    return {
        "status": "ready",
        "service": "extractor-python",
        "checks": [
            {"name": "http", "status": "ok"},
            {"name": "extractor", "status": "ready"},
        ],
    }


@app.post("/extract")
def extract(payload: ExtractRequest) -> JSONResponse:
    try:
        result = perform_extraction(payload)
        return JSONResponse(status_code=200, content=result)
    except ControlledExtractionError as error:
        return JSONResponse(
            status_code=error.status_code,
            content={
                "status": "error",
                "code": error.code,
                "message": error.message,
                "warnings": error.warnings,
            },
        )


def perform_extraction(payload: ExtractRequest) -> dict[str, Any]:
    if payload.sourceType not in SOURCE_TYPES:
        raise ControlledExtractionError(
            "unsupported-source",
            f"Unsupported sourceType: {payload.sourceType}",
            status_code=415,
        )

    handlers = {
        "inline-text": extract_inline_text,
        "txt": extract_txt,
        "url": extract_url,
        "docx": extract_docx,
        "pdf": extract_pdf,
    }
    raw_result = handlers[payload.sourceType](payload)
    sections = [section.model_dump(exclude_none=True) for section in raw_result["sections"]]
    response = {
        "status": "ok",
        "documentId": payload.documentId,
        "sourceType": payload.sourceType,
        "rawText": raw_result["rawText"],
        "sections": sections,
        "warnings": raw_result["warnings"],
        "metadata": raw_result["metadata"],
    }
    if raw_result["normalizedText"]:
        response["normalizedText"] = raw_result["normalizedText"]
    if raw_result["language"]:
        response["language"] = raw_result["language"]
    if raw_result["pageCount"] is not None:
        response["pageCount"] = raw_result["pageCount"]
    return response


def extract_inline_text(payload: ExtractRequest) -> dict[str, Any]:
    if not payload.inlineText or not payload.inlineText.strip():
        raise ControlledExtractionError(
            "validation-error",
            "inlineText is required for sourceType=inline-text.",
        )

    raw_text = clean_text(payload.inlineText)
    if not raw_text:
        raise ControlledExtractionError(
            "validation-error",
            "inlineText does not contain readable text.",
        )

    normalized_text = normalize_text(raw_text)
    sections = build_sections_from_text(normalized_text)
    warnings: list[str] = []
    if len(normalized_text) < 120:
        warnings.append("very-short-input")

    return build_success_payload(
        payload,
        raw_text=raw_text,
        normalized_text=normalized_text,
        sections=sections,
        warnings=warnings,
        metadata={
            "inputKind": "inline-text",
            "characterCount": len(normalized_text),
            "sectionCount": len(sections),
        },
    )


def extract_txt(payload: ExtractRequest) -> dict[str, Any]:
    warnings: list[str] = []
    if payload.inlineText and payload.inlineText.strip() and not payload.sourceUri:
        warnings.append("inline-text-used-for-txt")
        raw_text = clean_text(payload.inlineText)
    else:
        source_uri = validate_source_uri(payload, allow_http=True, allow_local=True)
        if is_http_uri(source_uri):
            downloaded = download_binary(source_uri)
            raw_text = decode_text_bytes(downloaded["body"])
            warnings.extend(downloaded["warnings"])
        else:
            raw_text = read_local_text(Path(source_uri))

    if not raw_text:
        raise ControlledExtractionError(
            "extract-failed",
            "Text file is empty or could not be decoded.",
            warnings=warnings,
            status_code=422,
        )

    normalized_text = normalize_text(raw_text)
    sections = build_sections_from_text(normalized_text)
    return build_success_payload(
        payload,
        raw_text=raw_text,
        normalized_text=normalized_text,
        sections=sections,
        warnings=warnings,
        metadata={
            "inputKind": "txt",
            "characterCount": len(normalized_text),
            "sectionCount": len(sections),
        },
    )


def extract_url(payload: ExtractRequest) -> dict[str, Any]:
    source_uri = validate_source_uri(payload, allow_http=True, allow_local=False)
    downloaded = download_binary(source_uri)
    content_type = downloaded["content_type"].lower()
    warnings = list(downloaded["warnings"])

    if "text/plain" in content_type:
        raw_text = decode_text_bytes(downloaded["body"])
        normalized_text = normalize_text(raw_text)
        sections = build_sections_from_text(normalized_text)
        warnings.append("url-returned-plain-text")
        return build_success_payload(
            payload,
            raw_text=raw_text,
            normalized_text=normalized_text,
            sections=sections,
            warnings=warnings,
            metadata={
                "inputKind": "url",
                "title": infer_title_from_text(normalized_text),
                "characterCount": len(normalized_text),
                "contentType": content_type or "unknown",
                "sectionCount": len(sections),
            },
        )

    html = decode_text_bytes(downloaded["body"])
    soup = BeautifulSoup(html, "html.parser")
    page_title = extract_html_title(soup)
    extracted = trafilatura.extract(
        html,
        include_comments=False,
        include_links=False,
        include_images=False,
        include_tables=True,
        deduplicate=True,
        favor_precision=True,
        url=source_uri,
    )

    if not extracted:
        extracted = fallback_extract_html_text(soup)
        warnings.append("trafilatura-fallback-used")

    raw_text = clean_text(extracted)
    if not raw_text:
        paywall_warning = detect_paywall(html)
        if paywall_warning:
            warnings.append(paywall_warning)
        raise ControlledExtractionError(
            "extract-failed",
            "Could not extract meaningful text from the URL.",
            warnings=warnings,
            status_code=422,
        )

    normalized_text = normalize_text(raw_text)
    sections = build_sections_from_html(soup, normalized_text)

    if len(normalized_text) < 180:
        paywall_warning = detect_paywall(html)
        if paywall_warning:
            warnings.append(paywall_warning)
        warnings.append("low-text-density")

    return build_success_payload(
        payload,
        raw_text=raw_text,
        normalized_text=normalized_text,
        sections=sections,
        warnings=warnings,
        metadata={
            "inputKind": "url",
            "title": page_title or infer_title_from_text(normalized_text),
            "characterCount": len(normalized_text),
            "contentType": content_type or "unknown",
            "sectionCount": len(sections),
        },
    )


def extract_docx(payload: ExtractRequest) -> dict[str, Any]:
    source_uri = validate_source_uri(payload, allow_http=True, allow_local=True)
    warnings: list[str] = []

    if is_http_uri(source_uri):
        downloaded = download_binary(source_uri)
        body = io.BytesIO(downloaded["body"])
        warnings.extend(downloaded["warnings"])
    else:
        path = Path(source_uri)
        ensure_local_file(path)
        body = str(path)

    try:
        document = DocxDocument(body)
    except Exception as exc:  # pragma: no cover - controlled path
        raise ControlledExtractionError(
            "extract-failed",
            f"Failed to open DOCX file: {exc}",
            warnings=warnings,
            status_code=422,
        ) from exc

    raw_blocks: list[str] = []
    sections: list[ExtractSection] = []
    current_heading: str | None = None
    table_count = 0
    paragraph_count = 0

    for block in iter_block_items(document):
        if isinstance(block, Paragraph):
            text = clean_text(block.text)
            if not text:
                continue
            paragraph_count += 1
            style_name = (block.style.name or "").lower() if block.style is not None else ""
            if style_name.startswith("heading") or looks_like_heading(text):
                current_heading = normalize_heading(text)
                continue
            if style_name.startswith("list") or LIST_LINE_RE.match(text):
                text = ensure_list_prefix(text)
            raw_blocks.append(text)
            sections.append(
                ExtractSection(
                    heading=current_heading,
                    text=text,
                )
            )
            current_heading = None
        elif isinstance(block, Table):
            table_count += 1
            flattened = flatten_table(block)
            if not flattened:
                continue
            raw_blocks.append(flattened)
            sections.append(
                ExtractSection(
                    heading=current_heading,
                    text=flattened,
                )
            )
            current_heading = None

    raw_text = BLOCK_SEPARATOR.join(raw_blocks)
    if not raw_text:
        raise ControlledExtractionError(
            "extract-failed",
            "DOCX document does not contain extractable text.",
            warnings=warnings,
            status_code=422,
        )

    if table_count:
        warnings.append("tables-flattened-to-plain-text")

    normalized_text = normalize_text(raw_text)
    sections = [section for section in sections if section.text.strip()]
    if not sections:
        sections = build_sections_from_text(normalized_text)

    return build_success_payload(
        payload,
        raw_text=raw_text,
        normalized_text=normalized_text,
        sections=sections,
        warnings=warnings,
        metadata={
            "inputKind": "docx",
            "characterCount": len(normalized_text),
            "sectionCount": len(sections),
            "tableCount": table_count,
            "paragraphCount": paragraph_count,
        },
    )


def extract_pdf(payload: ExtractRequest) -> dict[str, Any]:
    source_uri = validate_source_uri(payload, allow_http=True, allow_local=True)
    warnings: list[str] = []

    try:
        if is_http_uri(source_uri):
            downloaded = download_binary(source_uri)
            pdf_doc = fitz.open(stream=downloaded["body"], filetype="pdf")
            warnings.extend(downloaded["warnings"])
        else:
            path = Path(source_uri)
            ensure_local_file(path)
            pdf_doc = fitz.open(path)
    except ControlledExtractionError:
        raise
    except Exception as exc:  # pragma: no cover - controlled path
        raise ControlledExtractionError(
            "extract-failed",
            f"Failed to open PDF file: {exc}",
            warnings=warnings,
            status_code=422,
        ) from exc

    with pdf_doc:
        page_count = pdf_doc.page_count
        sections: list[ExtractSection] = []
        raw_pages: list[str] = []
        empty_pages = 0

        for index, page in enumerate(pdf_doc, start=1):
            blocks = [
                clean_text(block[4])
                for block in page.get_text("blocks")
                if len(block) >= 5 and clean_text(block[4])
            ]
            if not blocks:
                empty_pages += 1
                continue

            page_heading: str | None = None
            content_blocks = blocks
            if blocks and looks_like_heading(blocks[0]):
                page_heading = normalize_heading(blocks[0])
                content_blocks = blocks[1:] if len(blocks) > 1 else blocks

            page_text = BLOCK_SEPARATOR.join(content_blocks).strip()
            if not page_text:
                empty_pages += 1
                continue

            page_text_with_marker = f"[Page {index}]\n{page_text}"
            raw_pages.append(page_text_with_marker)
            sections.append(
                ExtractSection(
                    heading=page_heading,
                    text=page_text,
                    pageStart=index,
                    pageEnd=index,
                )
            )

        raw_text = BLOCK_SEPARATOR.join(raw_pages)
        if not raw_text or len(strip_non_content(raw_text)) < 80:
            warning_list = list(warnings)
            warning_list.append("possible-image-only-or-unreadable-pdf")
            raise ControlledExtractionError(
                "extract-failed",
                "PDF appears to contain little or no extractable text. OCR is not enabled in this MVP.",
                warnings=warning_list,
                status_code=422,
            )

        if empty_pages:
            warnings.append(f"empty-pages:{empty_pages}")
        if empty_pages == page_count:
            warnings.append("all-pages-empty")

        normalized_text = normalize_text(raw_text)
        return build_success_payload(
            payload,
            raw_text=raw_text,
            normalized_text=normalized_text,
            sections=sections,
            warnings=warnings,
            page_count=page_count,
            metadata={
                "inputKind": "pdf",
                "characterCount": len(normalized_text),
                "sectionCount": len(sections),
                "emptyPages": empty_pages,
            },
        )


def build_success_payload(
    payload: ExtractRequest,
    *,
    raw_text: str,
    normalized_text: str,
    sections: list[ExtractSection],
    warnings: list[str],
    metadata: dict[str, str | int | bool | None],
    page_count: int | None = None,
) -> dict[str, Any]:
    language = payload.language or detect_language(normalized_text or raw_text)
    return {
        "rawText": raw_text,
        "normalizedText": normalized_text if normalized_text != raw_text else normalized_text,
        "language": language,
        "pageCount": page_count,
        "sections": sections or [ExtractSection(text=normalized_text[:4000])],
        "warnings": dedupe_strings(warnings),
        "metadata": metadata,
    }


def validate_source_uri(
    payload: ExtractRequest,
    *,
    allow_http: bool,
    allow_local: bool,
) -> str:
    source_uri = (payload.sourceUri or "").strip()
    if not source_uri:
        raise ControlledExtractionError(
            "validation-error",
            "sourceUri is required for this sourceType.",
        )

    parsed = urlparse(source_uri)
    if parsed.scheme in SYNTHETIC_SCHEMES:
        raise ControlledExtractionError(
            "validation-error",
            f"Synthetic URI '{parsed.scheme}://' cannot be extracted directly without inlineText or a real file/URL.",
        )

    if is_http_uri(source_uri):
        if not allow_http:
            raise ControlledExtractionError(
                "unsupported-source",
                f"HTTP URLs are not supported for sourceType={payload.sourceType}.",
                status_code=415,
            )
        return source_uri

    if parsed.scheme and parsed.scheme != "file":
        raise ControlledExtractionError(
            "unsupported-source",
            f"Unsupported URI scheme '{parsed.scheme}' for sourceType={payload.sourceType}.",
            status_code=415,
        )

    if not allow_local:
        raise ControlledExtractionError(
            "validation-error",
            "Local file paths are not supported for this sourceType.",
        )

    return parsed.path if parsed.scheme == "file" else source_uri


def is_http_uri(value: str) -> bool:
    scheme = urlparse(value).scheme.lower()
    return scheme in {"http", "https"}


def download_binary(source_uri: str) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True, headers=DOWNLOAD_HEADERS) as client:
            response = client.get(source_uri)
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise ControlledExtractionError(
            "download-failed",
            f"Timed out while downloading {source_uri}",
            status_code=504,
        ) from exc
    except httpx.HTTPError as exc:
        raise ControlledExtractionError(
            "download-failed",
            f"Failed to download {source_uri}: {exc}",
            status_code=502,
        ) from exc

    warnings: list[str] = []
    content_type = response.headers.get("content-type", "")
    if not response.content:
        warnings.append("empty-response-body")

    return {
        "body": response.content,
        "content_type": content_type,
        "warnings": warnings,
    }


def read_local_text(path: Path) -> str:
    ensure_local_file(path)
    data = path.read_bytes()
    return decode_text_bytes(data)


def ensure_local_file(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise ControlledExtractionError(
            "validation-error",
            f"Local file does not exist: {path}",
        )


def decode_text_bytes(data: bytes) -> str:
    encodings = ("utf-8-sig", "utf-8", "utf-16", "cp1251", "latin-1")
    for encoding in encodings:
        try:
            decoded = data.decode(encoding)
            if decoded:
                return clean_text(decoded)
        except UnicodeDecodeError:
            continue
    return clean_text(data.decode("utf-8", errors="ignore"))


def clean_text(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.replace("\x00", "").replace("\u00ad", "")
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = re.sub(r"[ \t\f\v]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = clean_text(text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    paragraphs: list[str] = []
    buffer: list[str] = []
    for raw_line in text.split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line:
            if buffer:
                paragraphs.append(" ".join(buffer).strip())
                buffer = []
            continue
        if LIST_LINE_RE.match(line) or looks_like_heading(line):
            if buffer:
                paragraphs.append(" ".join(buffer).strip())
                buffer = []
            paragraphs.append(line)
            continue
        buffer.append(line)
    if buffer:
        paragraphs.append(" ".join(buffer).strip())
    normalized = BLOCK_SEPARATOR.join(paragraph for paragraph in paragraphs if paragraph)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def build_sections_from_text(text: str) -> list[ExtractSection]:
    blocks = [block.strip() for block in re.split(r"\n{2,}", text) if block.strip()]
    if not blocks:
        return []

    sections: list[ExtractSection] = []
    pending_heading: str | None = None
    for block in blocks:
        if looks_like_heading(block):
            pending_heading = normalize_heading(block)
            continue
        sections.append(
            ExtractSection(
                heading=pending_heading,
                text=block,
            )
        )
        pending_heading = None

    if not sections and pending_heading:
        sections.append(ExtractSection(heading=pending_heading, text=pending_heading))

    return sections


def build_sections_from_html(soup: BeautifulSoup, normalized_text: str) -> list[ExtractSection]:
    heading_candidates = [
        normalize_heading(node.get_text(" ", strip=True))
        for node in soup.find_all(["h1", "h2", "h3"])
        if clean_text(node.get_text(" ", strip=True))
    ]
    base_sections = build_sections_from_text(normalized_text)
    if not heading_candidates:
        return base_sections

    section_index = 0
    for heading in heading_candidates:
        while section_index < len(base_sections):
            current = base_sections[section_index]
            if not current.heading and len(current.text) >= 40:
                current.heading = heading
                section_index += 1
                break
            section_index += 1
    return base_sections


def fallback_extract_html_text(soup: BeautifulSoup) -> str:
    for selector in ("article", "main"):
        node = soup.select_one(selector)
        if node:
            text = clean_text(node.get_text("\n", strip=True))
            if len(text) > 120:
                return text

    paragraphs = [
        clean_text(node.get_text(" ", strip=True))
        for node in soup.find_all(["p", "li"])
        if clean_text(node.get_text(" ", strip=True))
    ]
    return BLOCK_SEPARATOR.join(paragraphs)


def extract_html_title(soup: BeautifulSoup) -> str | None:
    title = clean_text(soup.title.get_text(" ", strip=True) if soup.title else "")
    if title:
        return title
    heading = soup.find(["h1", "h2"])
    if heading:
        return clean_text(heading.get_text(" ", strip=True)) or None
    return None


def detect_paywall(html: str) -> str | None:
    lowered = html.lower()
    for marker in PAYWALL_MARKERS:
        if marker in lowered:
            return "possible-paywall"
    return None


def detect_language(text: str) -> str | None:
    if not text:
        return None
    russian_chars = len(RUSSIAN_CHARS_RE.findall(text))
    latin_chars = len(LATIN_CHARS_RE.findall(text))
    if russian_chars >= latin_chars and russian_chars > 10:
        return "ru"
    if latin_chars > russian_chars and latin_chars > 10:
        return "en"
    return None


def infer_title_from_text(text: str) -> str | None:
    first_block = next((block for block in re.split(r"\n{2,}", text) if block.strip()), "")
    if looks_like_heading(first_block):
        return normalize_heading(first_block)
    first_sentence = split_sentences(first_block)[:1]
    if first_sentence:
        candidate = first_sentence[0]
        if len(candidate) <= 90:
            return candidate
    return None


def split_sentences(text: str) -> list[str]:
    if not text:
        return []
    prepared = re.sub(r"\n{2,}", ". ", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9\"«])", prepared)
    sentences = [clean_text(part) for part in parts if clean_text(part)]
    return sentences


def looks_like_heading(text: str) -> bool:
    normalized = clean_text(text)
    if not normalized or len(normalized) > 120:
        return False
    if LIST_LINE_RE.match(normalized):
        return False
    word_count = len(TOKEN_RE.findall(normalized))
    if word_count == 0 or word_count > 14:
        return False
    if normalized.endswith(":"):
        return True
    if HEADING_LINE_RE.match(normalized) and normalized.count(",") <= 1:
        return True
    return False


def normalize_heading(text: str) -> str:
    heading = clean_text(text).rstrip(":")
    return heading[:120]


def ensure_list_prefix(text: str) -> str:
    stripped = text.strip()
    if LIST_LINE_RE.match(stripped):
        return stripped
    return f"- {stripped}"


def flatten_table(table: Table) -> str:
    rows: list[str] = []
    for row in table.rows:
        cells = [clean_text(cell.text) for cell in row.cells]
        if any(cells):
            rows.append(" | ".join(cell or " " for cell in cells))
    return BLOCK_SEPARATOR.join(row for row in rows if row.strip())


def iter_block_items(parent: _DocumentType | _Cell | _Row) -> Iterable[Paragraph | Table]:
    if isinstance(parent, _DocumentType):
        parent_element = parent.element.body
    elif isinstance(parent, _Cell):
        parent_element = parent._tc
    else:
        parent_element = parent._tr

    for child in parent_element.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, parent)
        elif isinstance(child, CT_Tbl):
            yield Table(child, parent)


def strip_non_content(text: str) -> str:
    return re.sub(r"[^A-Za-zА-Яа-яЁё0-9]+", "", text)


def dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("EXTRACTOR_HOST", "0.0.0.0"),
        port=int(os.environ.get("EXTRACTOR_PORT", "8000")),
        reload=False,
    )
