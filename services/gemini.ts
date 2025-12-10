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

// Helper to chunk string
const chunkString = (str: string, size: number) => {
  const numChunks = Math.ceil(str.length / size);
  const chunks = new Array(numChunks);
  for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = str.substring(o, o + size);
  }
  return chunks;
};

const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts structured data.
 * Supports MULTI-FILE comparison.
 * Strategy:
 * 1. Single PDF: Use "Page Chunking" to stay under RPM limits for massive files.
 * 2. Multiple Files: Load ALL files into context (up to 1M token limit) to allow cross-file comparison.
 */
export const extractStructuredData = async (
  prompt: string,
  rawText: string,
  files: FileData[] = [],
  onProgress?: (progress: number) => void,
  useFastModel: boolean = false
): Promise<ExtractedItem[]> => {
  const ai = getAiClient();
  const model = useFastModel ? "gemini-2.5-flash-lite" : "gemini-2.5-flash";

  // Case 1: Multiple Files (Comparison Mode)
  // We prioritize context over chunking here to allow the AI to "see" File A and File B together.
  if (files.length > 1) {
    console.log(`Processing ${files.length} files in Comparison Mode...`);
    onProgress?.(20);
    // Send all files in one request. 
    // Note: If files are extremely huge (e.g. 2x 500 page PDFs), this might hit payload limits.
    // But for "finding & comparing", splitting contexts usually breaks the logic.
    // We rely on Gemini 2.5 Flash's 1M context window.
    return await callGeminiExtractWithRetry(ai, model, prompt, rawText, files);
  }

  // Case 2: Single PDF (Extraction Mode) - Use chunking for massive files
  const singleFile = files.length === 1 ? files[0] : null;
  const isPdf = singleFile && (
    singleFile.mimeType === 'application/pdf' || 
    singleFile.name.toLowerCase().endsWith('.pdf')
  );

  if (singleFile && isPdf) {
    try {
      console.log("Checking PDF size...");
      onProgress?.(5);
      const pdfBytes = base64ToUint8Array(singleFile.base64);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      const MAX_PAGES_PER_CHUNK = 1; // Strict chunking for single-file massive extraction

      if (totalPages > MAX_PAGES_PER_CHUNK) {
        console.log(`Large PDF detected (${totalPages} pages). Splitting...`);
        const pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        const pageChunks = chunkArray(pageIndices, MAX_PAGES_PER_CHUNK);
        
        let aggregatedData: ExtractedItem[] = [];

        for (let i = 0; i < pageChunks.length; i++) {
          const chunkIndices = pageChunks[i];
          console.log(`Processing chunk ${i + 1}/${pageChunks.length}...`);
          
          const subDoc = await PDFDocument.create();
          const copiedPages = await subDoc.copyPages(pdfDoc, chunkIndices);
          copiedPages.forEach((page) => subDoc.addPage(page));
          
          const subDocBase64 = await subDoc.saveAsBase64();
          
          if (i > 0) {
            console.log("Throttling request for 10s...");
            await delay(10000); 
          }

          // Construct temporary file object for this chunk
          const chunkFile: FileData = { 
             ...singleFile, 
             base64: subDocBase64,
             name: `${singleFile.name}_chunk_${i}`
          };

          const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, rawText, [chunkFile]);
          aggregatedData = [...aggregatedData, ...chunkResponse];
          
          const percentage = Math.round(5 + ((i + 1) / pageChunks.length) * 90);
          onProgress?.(percentage);
        }
        return aggregatedData;
      }
    } catch (err) {
      console.warn("PDF splitting failed. Falling back to standard mode.", err);
    }
  }

  // Case 3: Large Text Splitting (Single text stream)
  const MAX_TEXT_LENGTH = 12000; 
  if (files.length === 0 && rawText.length > MAX_TEXT_LENGTH) {
      console.log(`Large Text input detected. Splitting...`);
      onProgress?.(5);
      const chunks = chunkString(rawText, MAX_TEXT_LENGTH);
      let aggregatedData: ExtractedItem[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await delay(10000);
        const chunkResponse = await callGeminiExtractWithRetry(ai, model, prompt, chunks[i], []);
        aggregatedData = [...aggregatedData, ...chunkResponse];
        const percentage = Math.round(5 + ((i + 1) / chunks.length) * 90);
        onProgress?.(percentage);
      }
      return aggregatedData;
  }

  // Case 4: Standard Execution (Single small file or small text)
  onProgress?.(10);
  const result = await callGeminiExtractWithRetry(ai, model, prompt, rawText, files);
  onProgress?.(100);
  return result;
};

const callGeminiExtractWithRetry = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  files: FileData[],
  retries = 20 
): Promise<ExtractedItem[]> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callGeminiExtract(ai, model, prompt, rawText, files);
    } catch (e: any) {
      console.error(`Attempt ${attempt} failed:`, e);
      if (attempt === retries) throw e; 
      
      const msg = (e.message || e.toString()).toLowerCase();

      if (msg.includes('429') || msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded')) {
         let waitTime = 30000; 
         if (attempt === 2) waitTime = 60000;
         if (attempt >= 3) waitTime = 90000;
         console.log(`Quota limit hit (Attempt ${attempt}). Pausing for ${waitTime/1000}s...`);
         await delay(waitTime);
         continue;
      }

      if (msg.includes('500') || msg.includes('503') || msg.includes('xhr') || msg.includes('fetch')) {
         await delay(attempt * 3000);
      } else {
         if (msg.includes('safety') || msg.includes('blocked')) throw e;
         if (attempt < 3) await delay(2000); else throw e; 
      }
    }
  }
  return [];
};

const callGeminiExtract = async (
  ai: GoogleGenAI, 
  model: string, 
  prompt: string, 
  rawText: string, 
  files: FileData[]
): Promise<ExtractedItem[]> => {
  let userContent: any[] = [];
  
  // Add all files as inline parts
  files.forEach(file => {
      userContent.push({
        inlineData: {
          mimeType: file.mimeType,
          data: file.base64,
        },
      });
  });
  
  // Construct prompt
  let textPrompt = `Extract structured data based on the goal: "${prompt}". Return a valid JSON Array.`;
  
  if (files.length > 1) {
      textPrompt = `COMPARE & EXTRACT TASK:
      1. You are provided with ${files.length} files.
      2. Goal: "${prompt}"
      3. Cross-reference data between the files if required by the goal.
      4. Output only the final matching/extracted data as a JSON Array.
      5. If finding matches, include details from both files where relevant.`;
  }

  if (rawText) {
    textPrompt += `\n\nAdditional Context/Instructions:\n${rawText}`;
  }
  
  userContent.push({ text: textPrompt });

  const response = await ai.models.generateContent({
    model,
    contents: {
      role: 'user',
      parts: userContent
    },
    config: {
      systemInstruction: `You are a data extraction and comparison engine.
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
        description: "Observations about data quality, patterns, matches between files, or anomalies."
      }
    },
    required: ["summary", "sentiment", "keyEntities", "suggestedActions", "heuristicAnalysis"]
  };

  await delay(2000);

  // Attempt 1: Gemini 3 Pro
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Analyze this extracted/compared dataset: ${dataStr}`,
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
    
    if (msg.includes('429')) {
        await delay(15000);
    } else {
        await delay(2000);
    }
    
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
             const flashMsg = (flashError.message || '').toLowerCase();
             if (flashMsg.includes('429')) {
                 await delay(30000); 
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