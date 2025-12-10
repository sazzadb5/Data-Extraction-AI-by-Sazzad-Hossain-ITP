import { ExportFormat, ExtractedItem, AnalysisResult } from "../types";

const KEYS = {
  INSTRUCTION: 'dataxtract_instruction',
  HISTORY: 'dataxtract_history',
  EXPORT_FORMAT: 'dataxtract_export_format',
  CACHED_DATA: 'dataxtract_cached_data',
  CACHED_ANALYSIS: 'dataxtract_cached_analysis'
};

export const getStoredInstruction = (): string => {
  if (typeof window === 'undefined') return "Extract key information into a table";
  return localStorage.getItem(KEYS.INSTRUCTION) || "Extract key information into a table";
};

export const setStoredInstruction = (instruction: string) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.INSTRUCTION, instruction);
};

export const getInstructionHistory = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(KEYS.HISTORY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const addToInstructionHistory = (instruction: string): string[] => {
  if (typeof window === 'undefined' || !instruction.trim()) return [];
  const history = getInstructionHistory();
  // Remove if exists to move to top, limit to 10
  const newHistory = [instruction, ...history.filter(i => i !== instruction)].slice(0, 10);
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(newHistory));
  return newHistory;
};

export const getStoredExportFormat = (): ExportFormat => {
  if (typeof window === 'undefined') return ExportFormat.CSV;
  return (localStorage.getItem(KEYS.EXPORT_FORMAT) as ExportFormat) || ExportFormat.CSV;
};

export const setStoredExportFormat = (format: ExportFormat) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.EXPORT_FORMAT, format);
};

// Persistence for Offline Capability
export const saveExtractionSession = (data: ExtractedItem[], analysis: AnalysisResult | null) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEYS.CACHED_DATA, JSON.stringify(data));
    if (analysis) {
      localStorage.setItem(KEYS.CACHED_ANALYSIS, JSON.stringify(analysis));
    }
  } catch (e) {
    console.warn("Storage full, could not save session");
  }
};

export const loadExtractionSession = (): { data: ExtractedItem[], analysis: AnalysisResult | null } => {
  if (typeof window === 'undefined') return { data: [], analysis: null };
  try {
    const d = localStorage.getItem(KEYS.CACHED_DATA);
    const a = localStorage.getItem(KEYS.CACHED_ANALYSIS);
    return {
      data: d ? JSON.parse(d) : [],
      analysis: a ? JSON.parse(a) : null
    };
  } catch {
    return { data: [], analysis: null };
  }
};