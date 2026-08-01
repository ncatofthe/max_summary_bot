export const documentSourceTypes = ["pdf", "docx", "txt", "url", "inline-text"] as const;
export type DocumentSourceType = (typeof documentSourceTypes)[number];

export const summaryModes = ["brief", "detailed", "key-points", "action-items"] as const;
export type SummaryMode = (typeof summaryModes)[number];

export const jobStatuses = [
  "created",
  "queued",
  "validating",
  "extracting",
  "chunking",
  "summarizing",
  "formatting",
  "sending",
  "completed",
  "failed",
  "expired"
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export interface Document {
  id: string;
  sourceType: DocumentSourceType;
  sourceUri?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  inlineText?: string;
  sha256?: string;
  storageKey?: string;
  language?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  documentId: string;
  mode: SummaryMode;
  status: JobStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ExtractSection {
  heading?: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface ExtractResult {
  documentId: string;
  sourceType: DocumentSourceType;
  rawText: string;
  normalizedText?: string;
  language?: string;
  pageCount?: number;
  sections: ExtractSection[];
  warnings?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  extractedAt: string;
}

export interface ExtractorRequest {
  documentId: string;
  sourceType: DocumentSourceType;
  sourceUri?: string;
  fileName?: string;
  mimeType?: string;
  inlineText?: string;
  language?: string;
}

export interface SummarizationRequest {
  document: Document;
  job: Job;
  mode: SummaryMode;
  extractResult: ExtractResult;
  locale?: string;
}

export interface SummarySection {
  title: string;
  content: string;
}

export interface SummarizationResult {
  documentId: string;
  jobId: string;
  mode: SummaryMode;
  shortSummary: string;
  detailedSummary?: string;
  keyPoints: string[];
  actionItems: string[];
  risks: string[];
  sections?: SummarySection[];
  warnings?: string[];
  generatedAt: string;
}

export interface Summary extends SummarizationResult {
  id: string;
  createdAt: string;
  updatedAt: string;
}
