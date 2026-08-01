import type {
  ExtractResult,
  ExtractSection,
  SummarizationRequest,
  SummarizationResult,
  SummaryMode,
  SummarySection
} from "@max-summary/shared-types";

export interface Summarizer {
  summarize(request: SummarizationRequest): Promise<SummarizationResult>;
}

type SupportedLanguage = "ru" | "en";
type FocusMode = "default" | "action" | "risk";

interface SectionAnalysis {
  title: string;
  text: string;
  sentences: string[];
  score: number;
  index: number;
}

interface SentenceAnalysis {
  text: string;
  score: number;
  sectionTitle: string;
  sectionIndex: number;
  index: number;
  tokens: string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "with",
  "will",
  "can",
  "may",
  "must",
  "should",
  "need",
  "needs",
  "required",
  "todo",
  "и",
  "в",
  "во",
  "на",
  "не",
  "что",
  "как",
  "по",
  "из",
  "к",
  "ко",
  "за",
  "для",
  "от",
  "до",
  "или",
  "ли",
  "но",
  "а",
  "так",
  "это",
  "эти",
  "этот",
  "быть",
  "есть",
  "уже",
  "нужно",
  "надо",
  "можно",
  "также",
  "если",
  "при",
  "после",
  "чтобы",
  "без",
  "под",
  "над",
  "до",
  "из-за",
  "для",
  "только",
  "ещё"
]);

const ACTION_MARKERS = [
  "action item",
  "action items",
  "next step",
  "next steps",
  "todo",
  "to do",
  "must",
  "should",
  "need to",
  "needs to",
  "required",
  "submit",
  "send",
  "prepare",
  "review",
  "approve",
  "update",
  "complete",
  "deliver",
  "provide",
  "ensure",
  "schedule",
  "contact",
  "follow up",
  "required to",
  "необходимо",
  "нужно",
  "надо",
  "следует",
  "требуется",
  "должен",
  "должна",
  "должны",
  "обязан",
  "обязана",
  "обязаны",
  "подготовить",
  "отправить",
  "согласовать",
  "проверить",
  "обновить",
  "заполнить",
  "предоставить",
  "сделать",
  "выполнить",
  "назначить",
  "связаться",
  "подписать",
  "оплатить",
  "подтвердить"
];

const RISK_MARKERS = [
  "risk",
  "risks",
  "issue",
  "issues",
  "blocker",
  "blockers",
  "warning",
  "warnings",
  "concern",
  "concerns",
  "unclear",
  "uncertain",
  "dependency",
  "dependencies",
  "problem",
  "problems",
  "may",
  "might",
  "could",
  "unless",
  "except",
  "limited",
  "delay",
  "failure",
  "failed",
  "missing",
  "timeout",
  "not specified",
  "unspecified",
  "risk of",
  "ограничение",
  "ограничения",
  "риск",
  "риски",
  "проблема",
  "проблемы",
  "зависимость",
  "зависимости",
  "неясно",
  "неясность",
  "неопредел",
  "предупреждение",
  "может",
  "могут",
  "если",
  "иначе",
  "без",
  "отсутствует",
  "отсутствуют",
  "не указано",
  "не определено",
  "конфликт",
  "конфликты"
];

const TOKEN_RE = /[A-Za-zА-Яа-яЁё0-9]+(?:[-'][A-Za-zА-Яа-яЁё0-9]+)?/gu;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/u;

const MESSAGES = {
  ru: {
    insufficient:
      "Данных мало: удалось извлечь только короткий фрагмент, поэтому summary опирается на ограниченный контекст.",
    noActionItems: "Явные действия или поручения в тексте не выделяются.",
    noRisks: "Явные риски и ограничения в тексте не выделяются.",
    summaryLead: "Коротко:",
    actionsLead: "Что требует действий:",
    detailLead: "Развёрнуто:",
    keyPointsLead: "Ключевые тезисы:"
  },
  en: {
    insufficient:
      "The source contains only a short fragment, so the summary is based on limited context.",
    noActionItems: "No explicit action items were found in the text.",
    noRisks: "No explicit risks or limitations were found in the text.",
    summaryLead: "In short:",
    actionsLead: "Action-oriented view:",
    detailLead: "Detailed view:",
    keyPointsLead: "Key points:"
  }
} as const;

export class StubSummarizer implements Summarizer {
  async summarize(request: SummarizationRequest): Promise<SummarizationResult> {
    return buildStubSummarizationResult(request);
  }
}

export function buildStubSummarizationResult(
  request: SummarizationRequest
): SummarizationResult {
  return buildDeterministicSummarizationResult(request);
}

export function buildDeterministicSummarizationResult(
  request: SummarizationRequest
): SummarizationResult {
  const language = detectLanguage(request.extractResult, request.locale);
  const messages = MESSAGES[language];
  const warnings = dedupeStrings([...(request.extractResult.warnings ?? [])]);
  const sourceText = pickSourceText(request.extractResult);
  const sections = analyzeSections(request.extractResult, sourceText, language);
  const sentences = scoreSentences(sections);
  const insufficient = isInsufficient(sourceText, sentences);

  if (insufficient) {
    warnings.push("insufficient-content");
  }

  const keyPoints = buildKeyPoints(sentences, request.mode, language, insufficient);
  const actionItems = buildActionItems(sentences, language, insufficient);
  const risks = buildRisks(sentences, language, insufficient);
  const summarySections = buildSummarySections(sections, request.mode, language);

  const shortSummary = buildShortSummary({
    mode: request.mode,
    language,
    sourceText,
    sentences,
    keyPoints,
    actionItems,
    insufficient
  });

  const detailedSummary = buildDetailedSummary({
    mode: request.mode,
    language,
    sections,
    keyPoints,
    actionItems,
    risks,
    insufficient
  });

  return {
    documentId: request.document.id,
    jobId: request.job.id,
    mode: request.mode,
    shortSummary,
    detailedSummary,
    keyPoints,
    actionItems,
    risks: risks.length > 0 ? risks : [messages.noRisks],
    warnings,
    sections: summarySections,
    generatedAt: new Date().toISOString()
  };
}

function detectLanguage(extractResult: ExtractResult, locale?: string): SupportedLanguage {
  const preferred = (locale ?? extractResult.language ?? "").toLowerCase();
  if (preferred.startsWith("ru")) {
    return "ru";
  }
  if (preferred.startsWith("en")) {
    return "en";
  }

  const text = pickSourceText(extractResult);
  const cyrillicCount = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyrillicCount >= latinCount ? "ru" : "en";
}

function pickSourceText(extractResult: ExtractResult): string {
  const direct = cleanText(extractResult.normalizedText ?? extractResult.rawText);
  if (direct.length > 0) {
    return direct;
  }

  return cleanText(
    extractResult.sections
      .map((section) => [section.heading, section.text].filter(Boolean).join("\n"))
      .join("\n\n")
  );
}

function analyzeSections(
  extractResult: ExtractResult,
  sourceText: string,
  language: SupportedLanguage
): SectionAnalysis[] {
  const rawSections = extractResult.sections.length > 0 ? extractResult.sections : splitFallbackSections(sourceText);

  return rawSections
    .map((section, index) => buildSectionAnalysis(section, index, language))
    .filter((section) => section.text.length > 0);
}

function buildSectionAnalysis(
  section: ExtractSection,
  index: number,
  language: SupportedLanguage
): SectionAnalysis {
  const title =
    section.heading?.trim() ||
    createGeneratedTitle(section.text, language, index);
  const text = cleanText(section.text);
  const sentences = splitSentences(text);
  const tokens = tokenize(`${title} ${text}`);
  const score =
    unique(tokens).length +
    (containsDigit(text) ? 3 : 0) +
    (section.heading ? 2 : 0) +
    Math.min(sentences.length, 6);

  return {
    title,
    text,
    sentences,
    score,
    index
  };
}

function splitFallbackSections(text: string): ExtractSection[] {
  return text
    .split(/\n{2,}/u)
    .map((block) => cleanText(block))
    .filter(Boolean)
    .map((block) => ({ text: block }));
}

function scoreSentences(sections: SectionAnalysis[]): SentenceAnalysis[] {
  const allSentences = sections.flatMap((section, sectionIndex) =>
    section.sentences.map((sentence, sentenceIndex) => ({
      sentence,
      section,
      sectionIndex,
      sentenceIndex
    }))
  );

  const frequencies = buildFrequencyMap(allSentences.map((item) => item.sentence).join(" "));

  return allSentences
    .map(({ sentence, section, sectionIndex, sentenceIndex }) => {
      const tokens = tokenize(sentence).filter((token) => !STOP_WORDS.has(token));
      const uniqueTokens = unique(tokens);
      const tokenScore = uniqueTokens.reduce((sum, token) => sum + (frequencies.get(token) ?? 0), 0);
      const structuralBonus =
        (sectionIndex === 0 ? 1.2 : 0) +
        (sentenceIndex === 0 ? 0.8 : 0) +
        (containsDigit(sentence) ? 1.1 : 0) +
        (section.title ? 0.4 : 0);
      const actionBonus = hasMarker(sentence, ACTION_MARKERS) ? 1.6 : 0;
      const riskBonus = hasMarker(sentence, RISK_MARKERS) ? 1.4 : 0;
      const lengthPenalty =
        sentence.length < 35 ? 0.7 : sentence.length > 320 ? -1.1 : 0;
      const score =
        tokenScore / Math.max(2, Math.sqrt(Math.max(uniqueTokens.length, 1))) +
        structuralBonus +
        actionBonus +
        riskBonus +
        lengthPenalty;

      return {
        text: finalizeSentence(sentence),
        score,
        sectionTitle: section.title,
        sectionIndex,
        index: sentenceIndex,
        tokens: uniqueTokens
      };
    })
    .filter((item) => item.text.length > 0)
    .sort((left, right) => right.score - left.score);
}

function buildFrequencyMap(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (STOP_WORDS.has(token) || token.length < 3) {
      continue;
    }
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function buildKeyPoints(
  sentences: SentenceAnalysis[],
  mode: SummaryMode,
  language: SupportedLanguage,
  insufficient: boolean
): string[] {
  if (insufficient) {
    return [MESSAGES[language].insufficient];
  }

  const limit = mode === "detailed" ? 6 : 5;
  return selectSentences(sentences, limit, "default").map((item) => item.text);
}

function buildActionItems(
  sentences: SentenceAnalysis[],
  language: SupportedLanguage,
  insufficient: boolean
): string[] {
  if (insufficient) {
    return [MESSAGES[language].noActionItems];
  }

  const explicit = selectSentences(
    sentences.filter((sentence) => hasMarker(sentence.text, ACTION_MARKERS) || looksLikeDirective(sentence.text)),
    5,
    "action"
  ).map((item) => item.text);

  if (explicit.length > 0) {
    return explicit;
  }

  return [MESSAGES[language].noActionItems];
}

function buildRisks(
  sentences: SentenceAnalysis[],
  language: SupportedLanguage,
  insufficient: boolean
): string[] {
  if (insufficient) {
    return [MESSAGES[language].noRisks];
  }

  const explicit = selectSentences(
    sentences.filter((sentence) => looksLikeRiskSentence(sentence.text)),
    5,
    "risk"
  ).map((item) => item.text);

  if (explicit.length > 0) {
    return explicit;
  }

  return [];
}

function buildShortSummary(input: {
  mode: SummaryMode;
  language: SupportedLanguage;
  sourceText: string;
  sentences: SentenceAnalysis[];
  keyPoints: string[];
  actionItems: string[];
  insufficient: boolean;
}): string {
  const messages = MESSAGES[input.language];
  if (input.insufficient) {
    return messages.insufficient;
  }

  switch (input.mode) {
    case "brief": {
      const topSentences = selectSentences(input.sentences, 2, "default").map((item) => item.text);
      return composeLead(messages.summaryLead, topSentences.join(" "));
    }
    case "detailed": {
      const topSentences = selectSentences(input.sentences, 3, "default").map((item) => item.text);
      return composeLead(messages.detailLead, topSentences.join(" "));
    }
    case "key-points": {
      const lead = input.keyPoints.slice(0, 3).join(" ");
      return composeLead(messages.keyPointsLead, lead);
    }
    case "action-items": {
      const leadItems = input.actionItems.slice(0, 3).join(" ");
      return composeLead(messages.actionsLead, leadItems || messages.noActionItems);
    }
  }
}

function buildDetailedSummary(input: {
  mode: SummaryMode;
  language: SupportedLanguage;
  sections: SectionAnalysis[];
  keyPoints: string[];
  actionItems: string[];
  risks: string[];
  insufficient: boolean;
}): string {
  const messages = MESSAGES[input.language];
  if (input.insufficient) {
    return messages.insufficient;
  }

  const topSections = [...input.sections]
    .sort((left, right) => right.score - left.score)
    .slice(0, input.mode === "detailed" ? 4 : 3);

  const sectionParagraphs = topSections.map((section) => {
    const topSectionSentences = selectSentences(
      scoreSentences([section]),
      input.mode === "detailed" ? 2 : 1,
      "default"
    ).map((item) => item.text);
    const body = topSectionSentences.join(" ");
    return section.title ? `${section.title}: ${body}` : body;
  });

  if (input.mode === "action-items") {
    const actions = input.actionItems.map((item) => `- ${item}`).join("\n");
    const risks = input.risks.length > 0 ? input.risks.map((item) => `- ${item}`).join("\n") : "";
    return [sectionParagraphs.join("\n\n"), actions, risks].filter(Boolean).join("\n\n");
  }

  if (input.mode === "key-points") {
    const points = input.keyPoints.map((item) => `- ${item}`).join("\n");
    return [sectionParagraphs.join("\n\n"), points].filter(Boolean).join("\n\n");
  }

  return sectionParagraphs.join("\n\n");
}

function buildSummarySections(
  sections: SectionAnalysis[],
  mode: SummaryMode,
  language: SupportedLanguage
): SummarySection[] {
  const limit = mode === "detailed" ? 4 : 3;
  return [...sections]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((section, index) => ({
      title: section.title || createGeneratedTitle(section.text, language, index),
      content: selectSentences(scoreSentences([section]), 2, "default")
        .map((item) => item.text)
        .join(" ")
    }))
    .filter((section) => section.content.length > 0);
}

function selectSentences(
  sentences: SentenceAnalysis[],
  limit: number,
  focus: FocusMode
): SentenceAnalysis[] {
  const seen = new Set<string>();
  const selected: SentenceAnalysis[] = [];
  const ordered = [...sentences]
    .map((sentence) => ({
      ...sentence,
      adjustedScore: sentence.score + focusBonus(sentence.text, focus)
    }))
    .sort((left, right) => right.adjustedScore - left.adjustedScore);

  for (const sentence of ordered) {
    const normalized = normalizeComparable(sentence.text);
    if (seen.has(normalized)) {
      continue;
    }
    if (selected.some((current) => overlapRatio(current.tokens, sentence.tokens) > 0.72)) {
      continue;
    }
    selected.push(sentence);
    seen.add(normalized);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function focusBonus(text: string, focus: FocusMode): number {
  if (focus === "action") {
    return hasMarker(text, ACTION_MARKERS) || looksLikeDirective(text) ? 2.2 : 0;
  }
  if (focus === "risk") {
    return hasMarker(text, RISK_MARKERS) ? 2.1 : 0;
  }
  return 0;
}

function splitSentences(text: string): string[] {
  if (!text) {
    return [];
  }

  const prepared = text
    .replace(/\r/g, "")
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(BULLET_RE, ""));

  const sentences: string[] = [];
  for (const line of prepared) {
    const parts = line.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9"«])/u);
    for (const part of parts) {
      const sentence = finalizeSentence(part);
      if (sentence.length > 0) {
        sentences.push(sentence);
      }
    }
  }
  return dedupeStrings(sentences);
}

function tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(TOKEN_RE), (match) => match[0]);
}

function cleanText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createGeneratedTitle(text: string, language: SupportedLanguage, index: number): string {
  const firstSentence = splitSentences(text)[0] ?? "";
  if (firstSentence.length > 0) {
    return trimTerminalPunctuation(truncate(firstSentence, 72));
  }
  return language === "ru" ? `Фрагмент ${index + 1}` : `Section ${index + 1}`;
}

function truncate(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function containsDigit(text: string): boolean {
  return /\d/u.test(text);
}

function hasMarker(text: string, markers: string[]): boolean {
  const normalized = text.toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
}

function looksLikeRiskSentence(text: string): boolean {
  const normalized = text.toLowerCase();
  if (normalized.includes("список рисков") || normalized.includes("list of risks")) {
    return false;
  }
  return hasMarker(text, RISK_MARKERS);
}

function looksLikeDirective(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    BULLET_RE.test(text) ||
    /^(please|ensure|review|submit|send|prepare|update|check|confirm|provide)\b/u.test(normalized) ||
    /^(нужно|надо|следует|требуется|подготовить|проверить|отправить|согласовать|обновить)\b/u.test(
      normalized
    )
  );
}

function isInsufficient(sourceText: string, sentences: SentenceAnalysis[]): boolean {
  const tokenCount = tokenize(sourceText).length;
  return tokenCount < 20 || sentences.length < 2;
}

function composeLead(lead: string, body: string): string {
  const normalizedBody = cleanText(body);
  return normalizedBody.length > 0 ? `${lead} ${normalizedBody}` : lead;
}

function finalizeSentence(text: string): string {
  const cleaned = cleanText(text).replace(/\s+/g, " ");
  if (cleaned.length === 0) {
    return "";
  }
  return /[.!?]$/u.test(cleaned) ? cleaned : `${cleaned}.`;
}

function trimTerminalPunctuation(text: string): string {
  return text.replace(/[.!?:;]+$/u, "").trim();
}

function normalizeComparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function overlapRatio(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(left.size, right.size);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
