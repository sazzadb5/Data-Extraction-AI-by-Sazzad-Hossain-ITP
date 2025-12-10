import React, { useState } from 'react';
import { Database, Zap, Cpu } from 'lucide-react';
import { InputSection } from './components/InputSection';
import { ResultsView } from './components/ResultsView';
import { extractStructuredData, analyzeExtractedData } from './services/gemini';
import { ExtractedItem, AnalysisResult, ProcessingStatus, FileData } from './types';

const App: React.FC = () => {
  const [rawText, setRawText] = useState("");
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [instruction, setInstruction] = useState("Extract key information into a table");
  
  const [extractedData, setExtractedData] = useState<ExtractedItem[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, step: 'idle' });

  const handleProcess = async () => {
    if (!process.env.API_KEY) {
      alert("Please ensure API_KEY is set in your environment.");
      return;
    }

    setStatus({ isProcessing: true, step: 'extracting', message: 'Extracting data (this may take a moment for large files)...' });
    setExtractedData([]);
    setAnalysis(null);

    try {
      // Step 1: Extract
      const data = await extractStructuredData(instruction, rawText, fileData);
      setExtractedData(data);

      if (data.length > 0) {
        setStatus({ isProcessing: true, step: 'analyzing', message: 'Analyzing patterns and sentiment...' });
        
        // Step 2: Analyze
        const analysisResult = await analyzeExtractedData(data);
        setAnalysis(analysisResult);
      }

      setStatus({ isProcessing: false, step: 'complete' });

    } catch (error: any) {
      console.error(error);
      setStatus({ isProcessing: false, step: 'error', message: error.message || "An unexpected error occurred." });
      alert(`Error: ${error.message || "Failed to process data."}`);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-50 backdrop-blur-md bg-opacity-80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600 rounded-lg shadow-lg shadow-blue-500/20">
              <Database size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">DataXtract <span className="text-blue-500">AI</span></h1>
              <p className="text-xs text-slate-400">High-Volume PDF & Data Engine</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm text-slate-400">
             <span className="flex items-center gap-1"><Zap size={14} className="text-yellow-400" /> 1M+ Token Context</span>
             <span className="flex items-center gap-1"><Cpu size={14} className="text-blue-400" /> Gemini 2.5</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow p-6 md:p-12">
        <div className="max-w-7xl mx-auto space-y-12">
          
          {/* Hero Text (Only show if no results yet) */}
          {extractedData.length === 0 && !status.isProcessing && (
            <div className="text-center space-y-4 py-8">
              <h2 className="text-4xl md:text-5xl font-extrabold text-white">
                Turn Chaos into <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Structured Data</span>
              </h2>
              <p className="text-slate-400 max-w-2xl mx-auto text-lg">
                Upload massive PDFs (5K+ pages), images, or text. Our AI extracts fields into Excel, CSV, or custom reports instantly.
              </p>
            </div>
          )}

          {/* Input Section */}
          <InputSection
            rawText={rawText}
            setRawText={setRawText}
            fileData={fileData}
            setFileData={setFileData}
            instruction={instruction}
            setInstruction={setInstruction}
            onProcess={handleProcess}
            isProcessing={status.isProcessing}
          />

          {/* Loading State */}
          {status.isProcessing && (
            <div className="flex flex-col items-center justify-center py-12 animate-pulse">
               <div className="h-12 w-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
               <p className="text-lg text-blue-400 font-medium">{status.message}</p>
            </div>
          )}

          {/* Results Section */}
          {!status.isProcessing && extractedData.length > 0 && (
            <ResultsView data={extractedData} analysis={analysis} />
          )}

        </div>
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 border-t border-slate-800 py-6 mt-12">
        <div className="max-w-7xl mx-auto px-4 text-center text-slate-500 text-sm">
          <p>© {new Date().getFullYear()} DataXtract AI. Powered by Google Gemini.</p>
        </div>
      </footer>

    </div>
  );
};

export default App;