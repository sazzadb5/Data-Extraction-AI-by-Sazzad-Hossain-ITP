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
  fileData?: FileData | null
): Promise<ExtractedItem[]> => {
  const ai = getAiClient();
  const model = "gemini-2.5-flash";

  // 1. Handle PDF Splitting
  const isPdf = fileData && (
    fileData.mimeType === 'application/pdf' || 
    fileData.name.toLowerCase().endsWith('.pdf')
  );

  if (fileData && isPdf) {
    try {
      console.log("Checking PDF size...");
      const pdfBytes = base64ToUint8Array(fileData.base64);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      // DRASTICALLY REDUCED CHUNK SIZE to prevent XHR/Network errors.
      // 10 pages is a safe bet for most network connections to avoid 500 errors.
      const MAX_PAGES_PER_CHUNK = 10; 

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
          
          // Add a small delay between chunks to avoid rate limiting
          if (i > 0) await delay(1000);

          const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, rawText, {
            ...fileData,
            base64: subDocBase64,
            mimeType: 'application/pdf'
          });
          
          aggregatedData = [...aggregatedData, ...chunkResponse];
        }
        
        return aggregatedData;
      }
    } catch (err) {
      console.warn("PDF pre-processing/splitting failed. Falling back to standard mode.", err);
    }
  }

  // 2. Handle Large Text Splitting
  // Reduced to 100k chars to avoid network payload limits (500 errors)
  const MAX_TEXT_LENGTH = 100000; 

  if (!fileData && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected (${rawText.length} chars). Splitting...`);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing text chunk ${i + 1}/${chunks.length}...`);
        // Add delay between chunks
        if (i > 0) await delay(1000);
        
        const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, chunks[i], null);
        aggregatedData = [...aggregatedData, ...chunkResponse];
      }
      return aggregatedData;
  }

  // Standard Execution (Images, Small Texts, Small PDFs)
  return callGeminiExtractWithRetry(ai, model, prompt, rawText, fileData);
};

// Wrapped call with Retry Logic
const callGeminiExtractWithRetry = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  fileData?: FileData | null,
  retries = 3
): Promise<ExtractedItem[]> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callGeminiExtract(ai, model, prompt, rawText, fileData);
    } catch (e: any) {
      console.error(`Attempt ${attempt} failed:`, e);
      if (attempt === retries) throw e; // Throw on final attempt
      
      // If error is 500/503 or network related, wait and retry
      if (e.message?.includes('500') || e.message?.includes('503') || e.message?.includes('xhr') || e.message?.includes('fetch')) {
         console.log(`Retrying in ${attempt * 2} seconds...`);
         await delay(attempt * 2000);
      } else {
        throw e; // Don't retry for other errors (like 400 Bad Request if validation fails, unless it's the token one which we can't really fix by retrying exactly same payload, but here we assume chunking handled that)
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
    return Array.isArray(json) ? json : [json];
  } catch (e) {
    console.warn("Failed to parse JSON from chunk, trying cleanup", text.substring(0, 100));
    // Fallback: try to find array in text
    const match = text.match(/\[.*\]/s);
    if (match) {
        try {
            return JSON.parse(match[0]);
        } catch (err) { return []; }
    }
    return [];
  }
};

/**
 * Analyzes the extracted data to provide summary and insights.
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  // Limit context for analysis
  const dataStr = JSON.stringify(data.slice(0, 2000)); 

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Analyze this dataset: ${dataStr}`,
    config: {
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
};