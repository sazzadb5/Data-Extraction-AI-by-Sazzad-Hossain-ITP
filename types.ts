
export interface ExtractedItem {
  [key: string]: string | number | boolean | null;
}

export interface AnalysisResult {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  keyEntities: string[];
  suggestedActions: string[];
  heuristicAnalysis: string[];
}

export interface ProcessingStatus {
  isProcessing: boolean;
  step: 'idle' | 'extracting' | 'analyzing' | 'complete' | 'error';
  message?: string;
  progress?: number;
}

export enum ExportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
  RTF = 'RTF',
  TXT = 'TXT'
}

export interface FileData {
  base64: string;
  mimeType: string;
  name: string;
}
