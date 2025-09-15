export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type Intent = {
  topic?: string;
  audience?: string;
  style?: string;
  goals?: string[];
  constraints?: string[];
  references?: string[];
};

export type OutlineSection = {
  id: string;
  title: string;
  goals?: string[];
  bullets?: string[];
  requiresEvidence?: boolean;
};

export type Outline = {
  title: string;
  sections: OutlineSection[];
};

export type DraftSection = {
  sectionId: string;
  markdown: string;
  citations?: { url?: string; snippet?: string; confidence?: number }[];
  risks?: string[];
};

export type ReviewIssue = {
  locationId: string;
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
  rationale?: string;
};

export type Review = { issues: ReviewIssue[]; };

export type Evidence = {
  claimId: string;
  sources: { url: string; snippet?: string; confidence?: number }[];
};

export type FinalDoc = {
  markdown: string;
  toc?: string[];
  references?: string[];
};

export type UploadedFile = {
  filename: string;
  path: string;
  mime?: string;
  size?: number;
};