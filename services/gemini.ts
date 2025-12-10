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
      
      // EXTREMELY CONSERVATIVE CHUNKING: 
      // 1 page per request to ensure lowest possible Token Per Minute (TPM) usage.
      const MAX_PAGES_PER_CHUNK = 1; 

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
          
          // STRICT RATE LIMITING:
          // Gemini Free Tier is ~15 RPM. 
          // We aim for 6 RPM (1 request every 10s) to be absolutely safe against 429s.
          if (i > 0) {
            console.log("Throttling request for 10s to manage RPM...");
            await delay(10000); 
          }

          const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, rawText, {
            ...fileData,
            base64: subDocBase64,
            mimeType: 'application/pdf'
          });
          
          aggregatedData = [...aggregatedData, ...chunkResponse];
          
          // Update progress
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
  // 12k chars is roughly 3k tokens. Safe for TPM limits.
  const MAX_TEXT_LENGTH = 12000; 

  if (!fileData && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected (${rawText.length} chars). Splitting...`);
      onProgress?.(5);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing text chunk ${i + 1}/${chunks.length}...`);
        
        // Throttling for text chunks
        if (i > 0) await delay(10000);
        
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

// Wrapped call with Infinite Patience Retry Logic
const callGeminiExtractWithRetry = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  fileData?: FileData | null,
  retries = 20 
): Promise<ExtractedItem[]> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callGeminiExtract(ai, model, prompt, rawText, fileData);
    } catch (e: any) {
      console.error(`Attempt ${attempt} failed:`, e);
      if (attempt === retries) throw e; 
      
      const msg = (e.message || e.toString()).toLowerCase();

      // Handle 429 / Quota specifically
      if (msg.includes('429') || msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded')) {
         // RECOVERY STRATEGY:
         // If we hit 429, the quota bucket for the minute is likely exhausted.
         // We must wait significantly to let it refill.
         // Attempt 1: 30s
         // Attempt 2: 60s
         // Attempt 3+: 90s
         
         let waitTime = 30000; 
         if (attempt === 2) waitTime = 60000;
         if (attempt >= 3) waitTime = 90000;
         
         console.log(`Quota limit hit (Attempt ${attempt}). Pausing for ${waitTime/1000}s to refill bucket...`);
         await delay(waitTime);
         continue;
      }

      // If error is 500/503 or network related
      if (msg.includes('500') || msg.includes('503') || msg.includes('xhr') || msg.includes('fetch')) {
         console.log(`Server error. Retrying in ${attempt * 3000} ms...`);
         await delay(attempt * 3000);
      } else {
         // Some other error. If safety blocked, abort.
         if (msg.includes('safety') || msg.includes('blocked')) throw e;
         
         // Transient errors
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
 * Fallback: gemini-3-pro-preview -> gemini-2.5-flash
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  const dataStr = JSON.stringify(data.slice(0, 300)); 
  
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

  // Wait a bit before analysis to let extraction quota cool down
  await delay(2000);

  // Attempt 1: Gemini 3 Pro
  try {
    console.log("Attempting analysis with Gemini 3 Pro...");
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Analyze this dataset: ${dataStr}`,
      config: {
        thinkingConfig: { thinkingBudget: 4096 }, 
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

    // If quota hit, wait significantly before fallback
    if (msg.includes('429')) {
        console.log("Pro model quota hit. Waiting 15s before fallback...");
        await delay(15000);
    } else {
        await delay(2000);
    }

    console.log("Falling back to Gemini 2.5 Flash for analysis...");
    
    // Attempt 2: Gemini 2.5 Flash
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
        } catch (flashError: any) {
             console.error(`Flash Analysis attempt ${i+1} failed`, flashError);
             const flashMsg = (flashError.message || '').toLowerCase();
             if (flashMsg.includes('429')) {
                 await delay(30000); // Heavy wait if even flash fails
             } else {
                 await delay(5000);
             }
        }
    }
  }

  return {
      summary: "Analysis failed due to persistent high API traffic. Data extraction is complete and available below.",
      sentiment: "neutral",
      keyEntities: [],
      suggestedActions: ["Export data to Excel for manual analysis"],
      heuristicAnalysis: ["AI Analysis service temporarily unavailable."]
  };
};