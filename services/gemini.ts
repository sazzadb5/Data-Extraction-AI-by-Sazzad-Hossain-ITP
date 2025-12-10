import { GoogleGenAI, Type } from "@google/genai";
import { ExtractedItem, AnalysisResult, FileData } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is missing");
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * Extracts structured data from unstructured text or file inputs (PDF/Images).
 * Uses Gemini 2.5 Flash which has a massive context window (1M+ tokens),
 * making it suitable for processing large documents (e.g. 5K page PDFs).
 */
export const extractStructuredData = async (
  prompt: string,
  rawText: string,
  fileData?: FileData | null
): Promise<ExtractedItem[]> => {
  const ai = getAiClient();

  // Dynamic schema for extraction: An array of objects.
  const responseSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        // Dynamic properties; relying on prompt instruction to define keys.
      },
    },
  };

  // Gemini 2.5 Flash is recommended for high-volume text and multimodal tasks.
  // It supports a very large context window, enabling entire books or long PDFs to be processed in one go.
  const model = "gemini-2.5-flash"; 

  let userContent: any[] = [];
  
  // Prioritize file content if available, but include text if present as context
  if (fileData) {
    userContent.push({
      inlineData: {
        mimeType: fileData.mimeType,
        data: fileData.base64,
      },
    });
    
    let textPrompt = `Extract structured data from this document based on the following goal: "${prompt}". Return a valid JSON Array.`;
    if (rawText) {
      textPrompt += `\n\nAdditional Context:\n${rawText}`;
    }
    userContent.push({ text: textPrompt });
  } else {
    // Text-only mode
    userContent.push({ text: `Extract the following data structures based on this instruction: "${prompt}".\n\nData Source:\n${rawText}` });
  }

  const response = await ai.models.generateContent({
    model,
    contents: {
      role: 'user',
      parts: userContent
    },
    config: {
      systemInstruction: "You are a high-capacity data extraction engine capable of processing large documents. You MUST output a valid JSON Array containing objects. Extract specific fields requested by the user. If data is missing, use null. Do not include markdown code blocks, just raw JSON. If the document is very large, ensure you extract a representative set or all data as requested.",
      responseMimeType: "application/json",
      temperature: 0.1, // Low temperature for factual extraction
    },
  });

  const text = response.text;
  if (!text) throw new Error("No data returned from AI");

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse AI response", text);
    throw new Error("AI response was not valid JSON");
  }
};

/**
 * Analyzes the extracted data to provide summary and insights.
 */
export const analyzeExtractedData = async (data: ExtractedItem[]): Promise<AnalysisResult> => {
  const ai = getAiClient();
  const dataStr = JSON.stringify(data.slice(0, 100)); // Increased context for analysis

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
          suggestedActions: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ["summary", "sentiment", "keyEntities", "suggestedActions"]
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No analysis returned");

  return JSON.parse(text) as AnalysisResult;
};