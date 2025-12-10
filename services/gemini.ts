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

/**
 * Extracts structured data from unstructured text or file inputs (PDF/Images).
 * Uses Gemini 2.5 Flash which has a 1M token context window.
 * Automatically splits inputs to bypass API limits, supporting effectively infinite size.
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
      
      // DRASTICALLY REDUCED CHUNK SIZE to satisfy 1M token limit.
      // 50 pages * ~5000 tokens (very dense) = 250k tokens.
      // This allows plenty of room for prompt and output overhead.
      const MAX_PAGES_PER_CHUNK = 50; 

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
          
          const chunkResponse = await callGeminiExtract(ai, model, prompt, rawText, {
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

  // 2. Handle Large Text Splitting (for massive CSV/TXT pastes)
  // 1 Token ~= 4 chars. 1M Tokens ~= 4M chars. 
  // We set a safety limit of ~3M chars (~750k tokens) to stay safe.
  const MAX_TEXT_LENGTH = 3000000; 

  if (!fileData && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected (${rawText.length} chars). Splitting...`);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing text chunk ${i + 1}/${chunks.length}...`);
        const chunkResponse = await callGeminiExtract(ai, model, prompt, chunks[i], null);
        aggregatedData = [...aggregatedData, ...chunkResponse];
      }
      return aggregatedData;
  }

  // Standard Execution (Images, Small Texts, Small PDFs)
  return callGeminiExtract(ai, model, prompt, rawText, fileData);
};

// Helper function for the actual API call
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

  try {
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

    const json = JSON.parse(text);
    return Array.isArray(json) ? json : [json];

  } catch (e: any) {
    console.error("Gemini API Call Failed:", e);
    // If we hit a token limit inside a chunk that was supposedly safe, we return empty to not crash the whole batch
    if (e.message && e.message.includes('token')) {
        console.error("Token limit hit in chunk.");
    }
    return [];
  }
};

/**
 * Analyzes the extracted data to provide summary and insights.
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  // We limit analysis context to ~5000 items to avoid token limits on the analysis step
  // 5000 items * ~20 tokens/item = 100k tokens. Safe.
  const dataStr = JSON.stringify(data.slice(0, 5000)); 

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