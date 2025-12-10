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
 * Uses Gemini 2.5 Flash which has a massive context window (1M+ tokens).
 * Automatically splits PDFs larger than 1000 pages to bypass API limits.
 */
export const extractStructuredData = async (
  prompt: string,
  rawText: string,
  fileData?: FileData | null
): Promise<ExtractedItem[]> => {
  const ai = getAiClient();
  const model = "gemini-2.5-flash";

  // Handle Large PDF Splitting
  // Check mimeType OR extension to be robust
  const isPdf = fileData && (
    fileData.mimeType === 'application/pdf' || 
    fileData.name.toLowerCase().endsWith('.pdf')
  );

  if (fileData && isPdf) {
    try {
      console.log("Attempting to load PDF for page count check...");
      // Convert to Uint8Array for more robust loading in pdf-lib
      const pdfBytes = base64ToUint8Array(fileData.base64);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      // Reduce chunk size to 500 to be safe and avoid timeouts/latency issues
      const MAX_PAGES_PER_CHUNK = 500; 

      if (totalPages > 1000) {
        console.log(`Large PDF detected (${totalPages} pages). Splitting into chunks...`);
        const pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        const pageChunks = chunkArray(pageIndices, MAX_PAGES_PER_CHUNK);
        
        let aggregatedData: ExtractedItem[] = [];

        // Process chunks sequentially to avoid rate limits and memory issues
        for (let i = 0; i < pageChunks.length; i++) {
          const chunkIndices = pageChunks[i];
          console.log(`Processing chunk ${i + 1}/${pageChunks.length} (${chunkIndices.length} pages)...`);
          
          const subDoc = await PDFDocument.create();
          const copiedPages = await subDoc.copyPages(pdfDoc, chunkIndices);
          copiedPages.forEach((page) => subDoc.addPage(page));
          
          const subDocBase64 = await subDoc.saveAsBase64();
          
          // Use the chunk as a new fileData object
          const chunkResponse = await callGeminiExtract(ai, model, prompt, rawText, {
            ...fileData,
            base64: subDocBase64,
            mimeType: 'application/pdf' // Ensure mimeType is set correctly for the chunk
          });
          
          aggregatedData = [...aggregatedData, ...chunkResponse];
        }
        
        return aggregatedData;
      }
    } catch (err) {
      console.warn("PDF pre-processing/splitting failed. Falling back to sending original file.", err);
      // We fall through to standard execution, which might error if file > 1000 pages, 
      // but it's the best fallback we have if local processing fails.
    }
  }

  // Standard Execution (Images, Text, Small PDFs, or failed split attempts)
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
  if (!text) return []; // Return empty array if no data generated for this chunk

  try {
    const json = JSON.parse(text);
    return Array.isArray(json) ? json : [json];
  } catch (e) {
    console.error("Failed to parse AI response", text);
    // Return empty array on parse failure to not break the whole chain
    return [];
  }
};

/**
 * Analyzes the extracted data to provide summary and insights.
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  // Gemini 2.5 Flash has a 1M token context window.
  // We can send a significantly larger portion of the dataset for analysis.
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