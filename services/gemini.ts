import { GoogleGenAI, Type } from "@google/genai";
import { PDFDocument } from 'pdf-lib';
import { ExtractedItem, AnalysisResult, FileData } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is missing");
  }
  return new GoogleGenAI({ apiKey });
};

// Helper to chunk array
const chunkArray = (arr: number[], size: number) => {
  const res = [];
  for (let i = 0; i < arr.length; i += size) {
    res.push(arr.slice(i, i + size));
  }
  return res;
};

// Helper to chunk string (for massive text inputs)
const chunkString = (str: string, size: number) => {
  const numChunks = Math.ceil(str.length / size);
  const chunks = new Array(numChunks);
  for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = str.substring(o, o + size);
  }
  return chunks;
};

// Helper to convert base64 to Uint8Array
const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

// Helper for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts structured data from unstructured text or file inputs (PDF/Images).
 * Uses Gemini 2.5 Flash which has a 1M token context window.
 * Automatically splits inputs to bypass API limits and network payload restrictions.
 */
export const extractStructuredData = async (
  prompt: string,
  rawText: string,
  fileData?: FileData | null,
  onProgress?: (progress: number) => void,
  useFastModel: boolean = false
): Promise<ExtractedItem[]> => {
  const ai = getAiClient();
  // Feature: Fast AI responses using gemini-2.5-flash-lite
  const model = useFastModel ? "gemini-2.5-flash-lite" : "gemini-2.5-flash";

  // 1. Handle PDF Splitting
  const isPdf = fileData && (
    fileData.mimeType === 'application/pdf' || 
    fileData.name.toLowerCase().endsWith('.pdf')
  );

  if (fileData && isPdf) {
    try {
      console.log("Checking PDF size...");
      onProgress?.(5); // Started
      const pdfBytes = base64ToUint8Array(fileData.base64);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      // DRASTICALLY REDUCED CHUNK SIZE to prevent XHR/Network errors (Error Code 500).
      // 3 pages is very safe for avoiding payload size limits even with image-heavy PDFs.
      const MAX_PAGES_PER_CHUNK = 3; 

      if (totalPages > MAX_PAGES_PER_CHUNK) {
        console.log(`Large PDF detected (${totalPages} pages). Splitting into ${MAX_PAGES_PER_CHUNK} page chunks...`);
        const pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        const pageChunks = chunkArray(pageIndices, MAX_PAGES_PER_CHUNK);
        
        let aggregatedData: ExtractedItem[] = [];

        // Process chunks sequentially
        for (let i = 0; i < pageChunks.length; i++) {
          const chunkIndices = pageChunks[i];
          console.log(`Processing chunk ${i + 1}/${pageChunks.length} (${chunkIndices.length} pages)...`);
          
          const subDoc = await PDFDocument.create();
          const copiedPages = await subDoc.copyPages(pdfDoc, chunkIndices);
          copiedPages.forEach((page) => subDoc.addPage(page));
          
          const subDocBase64 = await subDoc.saveAsBase64();
          
          // Increased delay to prevent 429 Rate Limit errors
          if (i > 0) await delay(2000);

          const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, rawText, {
            ...fileData,
            base64: subDocBase64,
            mimeType: 'application/pdf'
          });
          
          aggregatedData = [...aggregatedData, ...chunkResponse];
          
          // Update progress: Map 5% -> 95%
          const percentage = Math.round(5 + ((i + 1) / pageChunks.length) * 90);
          onProgress?.(percentage);
        }
        
        return aggregatedData;
      }
    } catch (err) {
      console.warn("PDF pre-processing/splitting failed. Falling back to standard mode.", err);
    }
  }

  // 2. Handle Large Text Splitting
  // Reduced to 30k chars to avoid network payload limits (500 errors)
  const MAX_TEXT_LENGTH = 30000; 

  if (!fileData && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected (${rawText.length} chars). Splitting...`);
      onProgress?.(5);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing text chunk ${i + 1}/${chunks.length}...`);
        // Increased delay to prevent 429 Rate Limit errors
        if (i > 0) await delay(2000);
        
        const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, chunks[i], null);
        aggregatedData = [...aggregatedData, ...chunkResponse];

        // Update progress
        const percentage = Math.round(5 + ((i + 1) / chunks.length) * 90);
        onProgress?.(percentage);
      }
      return aggregatedData;
  }

  // Standard Execution (Images, Small Texts, Small PDFs)
  onProgress?.(10); // Start
  const result = await callGeminiExtractWithRetry(ai, model, prompt, rawText, fileData);
  onProgress?.(100); // Finish
  return result;
};

// Wrapped call with Retry Logic
const callGeminiExtractWithRetry = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  fileData?: FileData | null,
  retries = 5 // Increased retries to handle rate limits better
): Promise<ExtractedItem[]> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callGeminiExtract(ai, model, prompt, rawText, fileData);
    } catch (e: any) {
      console.error(`Attempt ${attempt} failed:`, e);
      if (attempt === retries) throw e; // Throw on final attempt
      
      const msg = e.message?.toLowerCase() || '';

      // Handle 429 / Quota specifically with significant backoff
      if (msg.includes('429') || msg.includes('quota') || msg.includes('limit')) {
         const waitTime = attempt * 5000 + 2000; // 7s, 12s, 17s...
         console.log(`Quota limit hit (429). Pausing for ${waitTime}ms before retry...`);
         await delay(waitTime);
         continue;
      }

      // If error is 500/503 or network related, wait and retry
      if (msg.includes('500') || msg.includes('503') || msg.includes('xhr') || msg.includes('fetch')) {
         console.log(`Retrying in ${attempt * 2000} ms...`);
         await delay(attempt * 2000);
      } else {
        throw e; // Don't retry for other errors (like 400 Bad Request)
      }
    }
  }
  return [];
};

// Core API Call
const callGeminiExtract = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  fileData?: FileData | null
): Promise<ExtractedItem[]> => {
  let userContent: any[] = [];
  
  if (fileData) {
    userContent.push({
      inlineData: {
        mimeType: fileData.mimeType,
        data: fileData.base64,
      },
    });
    
    let textPrompt = `Extract structured data from this document part based on the following goal: "${prompt}". Return a valid JSON Array.`;
    if (rawText) {
      textPrompt += `\n\nAdditional Context:\n${rawText}`;
    }
    userContent.push({ text: textPrompt });
  } else {
    userContent.push({ text: `Extract the following data structures based on this instruction: "${prompt}".\n\nData Source:\n${rawText}` });
  }

  const response = await ai.models.generateContent({
    model,
    contents: {
      role: 'user',
      parts: userContent
    },
    config: {
      systemInstruction: `You are a high-capacity data extraction engine. 
      CRITICAL FORMATTING RULES:
      1. Output MUST be a valid JSON Array.
      2. PRESERVE LEADING ZEROS exactly as they appear (e.g., "026" stays "026").
      3. Treat ID numbers and codes as STRINGS.
      4. Extract specific data fields as requested. If a field is not found, use null.
      5. Do not include markdown code blocks. Just raw JSON.
      6. If processing a partial chunk of a larger document, extract all relevant complete records found in this chunk.`,
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) return [];

  try {
    const json = JSON.parse(text);
    
    // Safety check: Filter out nulls and invalid objects
    if (!json) return []; 

    if (Array.isArray(json)) {
      return json.filter(item => item !== null && typeof item === 'object');
    }
    
    // Handle single object response
    if (typeof json === 'object') {
      return [json];
    }

    return [];
  } catch (e) {
    console.warn("Failed to parse JSON from chunk, trying cleanup", text.substring(0, 100));
    // Fallback: try to find array in text
    const match = text.match(/\[.*\]/s);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) {
                return parsed.filter(item => item !== null && typeof item === 'object');
            }
        } catch (err) { return []; }
    }
    return [];
  }
};

/**
 * Analyzes the extracted data to provide summary and insights.
 * Feature: Think more when needed - Uses gemini-3-pro-preview with thinkingBudget
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  // Limit context for analysis to avoid huge payloads
  const dataStr = JSON.stringify(data.slice(0, 500)); 
  let retries = 3;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-pro-preview", // Use Pro for complex analysis
        contents: `Analyze this dataset: ${dataStr}`,
        config: {
          thinkingConfig: { thinkingBudget: 32768 }, // Enable Thinking Mode (Max budget)
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              sentiment: { type: Type.STRING, enum: ['positive', 'neutral', 'negative'] },
              keyEntities: { type: Type.ARRAY, items: { type: Type.STRING } },
              suggestedActions: { type: Type.ARRAY, items: { type: Type.STRING } },
              heuristicAnalysis: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "Heuristic observations about data quality, patterns, anomalies, or missing information."
              }
            },
            required: ["summary", "sentiment", "keyEntities", "suggestedActions", "heuristicAnalysis"]
          }
        }
      });

      const text = response.text;
      if (!text) throw new Error("No analysis returned");
      return JSON.parse(text) as AnalysisResult;

    } catch (e: any) {
       console.error(`Analysis attempt ${attempt} failed:`, e);
       if (attempt === retries) throw e;
       
       const msg = e.message?.toLowerCase() || '';
       if (msg.includes('429') || msg.includes('quota') || msg.includes('limit')) {
         const waitTime = attempt * 5000 + 3000;
         console.log(`Analysis Quota hit. Waiting ${waitTime}ms...`);
         await delay(waitTime);
       } else if (msg.includes('500') || msg.includes('503')) {
         await delay(2000);
       } else {
         throw e;
       }
    }
  }
  throw new Error("Analysis failed after retries");
};