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
  // Standard: gemini-2.5-flash (Balanced)
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
      
      // Conservative chunking: 2 pages per request to minimize token load per call
      const MAX_PAGES_PER_CHUNK = 2; 

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
          
          // SMART THROTTLING: 
          // Gemini Free Tier is ~15 RPM (Requests Per Minute). 
          // 60s / 15 = 4s per request.
          // We set delay to 5.5s to be safe and allow some buffer.
          if (i > 0) {
            console.log("Throttling request for 5.5s to manage RPM...");
            await delay(5500);
          }

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
  const MAX_TEXT_LENGTH = 15000; 

  if (!fileData && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected (${rawText.length} chars). Splitting...`);
      onProgress?.(5);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing text chunk ${i + 1}/${chunks.length}...`);
        
        // Throttling for text chunks
        if (i > 0) await delay(5500);
        
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

// Wrapped call with Bulletproof Retry Logic
const callGeminiExtractWithRetry = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  fileData?: FileData | null,
  retries = 20 // Huge retry limit to effectively wait out any quota pause
): Promise<ExtractedItem[]> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callGeminiExtract(ai, model, prompt, rawText, fileData);
    } catch (e: any) {
      console.error(`Attempt ${attempt} failed:`, e);
      if (attempt === retries) throw e; 
      
      const msg = (e.message || e.toString()).toLowerCase();

      // Handle 429 / Quota specifically with EXPONENTIAL + FIXED backoff
      if (msg.includes('429') || msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded')) {
         // Strategy: 
         // Attempts 1-3: Quick backoff (5s, 10s, 15s) for transient spikes
         // Attempts 4+: Long backoff (60s) for "bucket empty" scenarios
         let waitTime = 5000 * attempt;
         if (attempt >= 3) waitTime = 60000; // Wait a full minute if persistent
         
         console.log(`Quota limit hit (Attempt ${attempt}). Pausing for ${waitTime/1000}s...`);
         await delay(waitTime);
         continue;
      }

      // If error is 500/503 or network related, wait and retry
      if (msg.includes('500') || msg.includes('503') || msg.includes('xhr') || msg.includes('fetch')) {
         console.log(`Server error. Retrying in ${attempt * 3000} ms...`);
         await delay(attempt * 3000);
      } else {
         // Some other error. If it looks like a safety block, don't retry.
         if (msg.includes('safety') || msg.includes('blocked')) throw e;
         
         // Otherwise try a few times
         if (attempt < 3) {
             await delay(2000);
         } else {
            throw e; 
         }
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
      systemInstruction: `You are a data extraction engine.
      CRITICAL: Output ONLY a valid JSON Array of objects.
      - Keys: Use snake_case or camelCase consistently.
      - IDs: Keep as strings.
      - Dates: ISO 8601 format if possible.
      - Missing values: Use null.
      - Do not include Markdown formatting (no \`\`\`json).`,
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) return [];

  try {
    const json = JSON.parse(text);
    if (!json) return []; 

    if (Array.isArray(json)) {
      return json.filter(item => item !== null && typeof item === 'object');
    }
    
    if (typeof json === 'object') {
      return [json];
    }

    return [];
  } catch (e) {
    // Fallback regex
    const match = text.match(/\[.*\]/s);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) return parsed;
        } catch (err) { return []; }
    }
    return [];
  }
};

/**
 * Analyzes the extracted data.
 * Includes FALLBACK mechanism: 
 * Tries 'gemini-3-pro-preview' (smartest) -> Falls back to 'gemini-2.5-flash' (higher quota) on 429.
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  // Limit context for analysis
  const dataStr = JSON.stringify(data.slice(0, 500)); 
  
  // Common Schema for both models
  const schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      sentiment: { type: Type.STRING, enum: ['positive', 'neutral', 'negative'] },
      keyEntities: { type: Type.ARRAY, items: { type: Type.STRING } },
      suggestedActions: { type: Type.ARRAY, items: { type: Type.STRING } },
      heuristicAnalysis: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING },
        description: "Observations about data quality, patterns, or anomalies."
      }
    },
    required: ["summary", "sentiment", "keyEntities", "suggestedActions", "heuristicAnalysis"]
  };

  // Attempt 1: Gemini 3 Pro (Thinking Mode)
  try {
    console.log("Attempting analysis with Gemini 3 Pro...");
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Analyze this dataset: ${dataStr}`,
      config: {
        thinkingConfig: { thinkingBudget: 8192 }, // Reduced budget to be safer
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });
    
    if (response.text) {
        return JSON.parse(response.text) as AnalysisResult;
    }
    throw new Error("Empty response from Pro");

  } catch (e: any) {
    const msg = (e.message || e.toString()).toLowerCase();
    console.warn("Analysis with Pro model failed:", msg);

    // If it's a quota issue or any server error, fallback to Flash immediately
    // Wait briefly to clear any rapid-fire checks
    await delay(2000);

    console.log("Falling back to Gemini 2.5 Flash for analysis...");
    
    // Attempt 2: Gemini 2.5 Flash (No Thinking, High Quota)
    // We try this up to 3 times
    for (let i = 0; i < 3; i++) {
        try {
            const response = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: `Analyze this dataset carefully and provide insights: ${dataStr}`,
              config: {
                responseMimeType: "application/json",
                responseSchema: schema
              }
            });
            if (response.text) {
                return JSON.parse(response.text) as AnalysisResult;
            }
        } catch (flashError) {
             console.error(`Flash Analysis attempt ${i+1} failed`, flashError);
             await delay(5000); // Wait 5s before retry
        }
    }
  }

  // If both failed, return a dummy result to prevent app crash
  return {
      summary: "Analysis failed due to high API traffic. Please try regenerating analysis later.",
      sentiment: "neutral",
      keyEntities: [],
      suggestedActions: ["Try manual analysis", "Export data to Excel"],
      heuristicAnalysis: ["Data extraction was successful, but AI analysis could not complete."]
  };
};