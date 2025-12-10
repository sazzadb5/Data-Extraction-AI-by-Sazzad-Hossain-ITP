import React, { useState, useEffect } from 'react';
import { Database, Zap, Cpu, AlertCircle, Brain, Layers, Wifi, WifiOff } from 'lucide-react';
import { InputSection } from './components/InputSection';
import { ResultsView } from './components/ResultsView';
import { extractStructuredData, analyzeExtractedData } from './services/gemini';
import { ExtractedItem, AnalysisResult, ProcessingStatus, FileData, ExportFormat } from './types';
import { 
  getStoredInstruction, 
  setStoredInstruction, 
  getInstructionHistory, 
  addToInstructionHistory,
  getStoredExportFormat,
  setStoredExportFormat,
  saveExtractionSession,
  loadExtractionSession
} from './utils/storage';

const App: React.FC = () => {
  // Initialize state from localStorage
  const [rawText, setRawText] = useState("");
  const [files, setFiles] = useState<FileData[]>([]);
  
  const [instruction, setInstructionState] = useState(getStoredInstruction());
  const [history, setHistory] = useState<string[]>([]);
  const [preferredFormat, setPreferredFormat] = useState<ExportFormat>(ExportFormat.CSV);
  
  const [extractedData, setExtractedData] = useState<ExtractedItem[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
  // Model preference state
  const [useFastModel, setUseFastModel] = useState(false);
  
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, step: 'idle', progress: 0 });

  // Load history, format, and previous session on mount
  useEffect(() => {
    setHistory(getInstructionHistory());
    setPreferredFormat(getStoredExportFormat());
    
    // Load last session for offline viewing
    const session = loadExtractionSession();
    if (session.data.length > 0) {
      setExtractedData(session.data);
      setAnalysis(session.analysis);
    }

    // Network listeners
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const setInstruction = (newInstruction: string) => {
    setInstructionState(newInstruction);
    setStoredInstruction(newInstruction);
  };

  const handleFormatChange = (format: ExportFormat) => {
    setPreferredFormat(format);
    setStoredExportFormat(format);
  };

  const getFriendlyErrorMessage = (error: any): string => {
    const msg = (error.message || error.toString()).toLowerCase();
    if (!navigator.onLine) {
      return "You are offline. Please connect to the internet to perform new extractions.";
    }
    if (msg.includes('401') || msg.includes('api key')) {
      return "Authentication failed. Please check if your API Key is valid and set correctly.";
    }
    if (msg.includes('429') || msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded')) {
      return "Usage limit exceeded. The app paused and retried multiple times, but the API quota is still exhausted. Please wait 1-2 minutes before trying again.";
    }
    if (msg.includes('503') || msg.includes('overloaded')) {
      return "The AI service is currently experiencing high traffic. Please try again in a few seconds.";
    }
    if (msg.includes('safety') || msg.includes('blocked')) {
      return "The content was flagged by safety filters. Please review your document or text for sensitive content.";
    }
    if (msg.includes('json') || msg.includes('parse')) {
      return "The AI extracted data but it wasn't in the correct format. Try refining your extraction goal to be more specific.";
    }
    if (msg.includes('fetch') || msg.includes('network')) {
      return "Network error. Please check your internet connection.";
    }
    return error.message || "An unexpected error occurred. Please try again.";
  };

  const validateInput = (): boolean => {
    if (!isOnline) {
      setStatus({ isProcessing: false, step: 'error', message: "Offline Mode: AI extraction requires an internet connection." });
      return false;
    }
    if (!instruction.trim()) {
      setStatus({ isProcessing: false, step: 'error', message: "Please provide an extraction/comparison goal." });
      return false;
    }
    if (!rawText.trim() && files.length === 0) {
      setStatus({ isProcessing: false, step: 'error', message: "Please upload files or paste text content to process." });
      return false;
    }
    return true;
  };

  const handleProcess = async () => {
    if (!process.env.API_KEY) {
      setStatus({ isProcessing: false, step: 'error', message: "API Key is missing. Please configure your environment." });
      return;
    }

    if (!validateInput()) {
      return;
    }

    const newHistory = addToInstructionHistory(instruction);
    setHistory(newHistory);

    setStatus({ isProcessing: true, step: 'extracting', message: 'Initializing...', progress: 0 });
    setExtractedData([]);
    setAnalysis(null);

    try {
      const data = await extractStructuredData(
        instruction, 
        rawText, 
        files,
        (progress) => setStatus(prev => ({ ...prev, progress, message: `Processing data (${progress}%)...` })),
        useFastModel
      );
      
      setExtractedData(data);
      // Autosave intermediate result
      saveExtractionSession(data, null);

      if (data.length > 0) {
        setStatus({ isProcessing: true, step: 'analyzing', message: 'Deep thinking analysis in progress...', progress: 100 });
        const analysisResult = await analyzeExtractedData(data);
        setAnalysis(analysisResult);
        // Autosave final result
        saveExtractionSession(data, analysisResult);
      } else {
        setStatus({ isProcessing: false, step: 'error', message: "No relevant data found matching your criteria.", progress: 0 });
        return;
      }

      setStatus({ isProcessing: false, step: 'complete', progress: 100 });

    } catch (error: any) {
      console.error("Processing Error:", error);
      const friendlyMsg = getFriendlyErrorMessage(error);
      setStatus({ isProcessing: false, step: 'error', message: friendlyMsg, progress: 0 });
    }
  };

  const handleReAnalyze = async () => {
    if (extractedData.length === 0 || !isOnline) return;

    setStatus({ isProcessing: true, step: 'analyzing', message: 'Re-analyzing extracted data...', progress: 100 });
    setAnalysis(null);

    try {
        const analysisResult = await analyzeExtractedData(extractedData);
        setAnalysis(analysisResult);
        saveExtractionSession(extractedData, analysisResult);
        setStatus({ isProcessing: false, step: 'complete', progress: 100 });
    } catch (error: any) {
        console.error("Re-analysis Error:", error);
        const friendlyMsg = getFriendlyErrorMessage(error);
        setStatus({ isProcessing: false, step: 'error', message: friendlyMsg, progress: 0 });
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
          <div className="flex items-center gap-4 text-sm font-medium">
             {/* Offline Indicator */}
             {!isOnline ? (
               <div className="flex items-center gap-2 px-3 py-1 bg-red-500/10 text-red-400 rounded-full border border-red-500/20 animate-pulse">
                 <WifiOff size={14} />
                 <span>Offline Mode</span>
               </div>
             ) : (
               <div className="hidden sm:flex items-center gap-2 text-slate-500">
                 <Wifi size={14} className="text-green-500" />
                 <span className="text-xs">Online</span>
               </div>
             )}

             <div className="hidden sm:flex items-center gap-4 text-slate-400 border-l border-slate-700 pl-4">
                {files.length > 1 && <span className="flex items-center gap-1 text-green-400 animate-pulse"><Layers size={14} /> Compare Mode</span>}
                <span className="flex items-center gap-1"><Zap size={14} className="text-yellow-400" /> Flash Lite</span>
                <span className="flex items-center gap-1"><Cpu size={14} className="text-blue-400" /> Flash 2.5</span>
                <span className="flex items-center gap-1"><Brain size={14} className="text-purple-400" /> Pro 3</span>
             </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow p-6 md:p-12">
        <div className="max-w-7xl mx-auto space-y-12">
          
          {/* Offline Warning Banner */}
          {!isOnline && (
            <div className="bg-slate-800 border-l-4 border-yellow-500 p-4 rounded shadow-lg flex justify-between items-center">
               <div>
                  <h3 className="text-yellow-400 font-semibold">Connection Lost</h3>
                  <p className="text-slate-400 text-sm">You can view and export previously extracted data, but AI features are disabled.</p>
               </div>
               <WifiOff className="text-slate-600 h-8 w-8" />
            </div>
          )}

          {/* Hero Text */}
          {extractedData.length === 0 && !status.isProcessing && status.step !== 'error' && (
            <div className="text-center space-y-4 py-8">
              <h2 className="text-4xl md:text-5xl font-extrabold text-white">
                Multi-File <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Comparison & Extraction</span>
              </h2>
              <p className="text-slate-400 max-w-2xl mx-auto text-lg">
                Upload massive PDFs (5K+ pages), images, or text. Compare documents against each other or extract structured data instantly.
              </p>
            </div>
          )}

          {/* Input Section */}
          <InputSection
            rawText={rawText}
            setRawText={setRawText}
            files={files}
            setFiles={setFiles}
            instruction={instruction}
            setInstruction={setInstruction}
            history={history}
            onProcess={handleProcess}
            isProcessing={status.isProcessing}
            useFastModel={useFastModel}
            setUseFastModel={setUseFastModel}
          />

          {/* Loading / Progress State */}
          {status.isProcessing && (
            <div className="flex flex-col items-center justify-center py-12 max-w-xl mx-auto w-full space-y-4 animate-fade-in">
               <div className="w-full flex justify-between text-sm text-blue-400 font-medium mb-1">
                 <span>{status.message}</span>
                 <span>{status.progress || 0}%</span>
               </div>
               <div className="w-full bg-slate-800 border border-slate-700 rounded-full h-3 overflow-hidden shadow-inner relative">
                 <div 
                   className="bg-gradient-to-r from-blue-600 to-blue-400 h-full rounded-full transition-all duration-500 ease-out relative overflow-hidden" 
                   style={{ width: `${Math.max(2, status.progress || 0)}%` }}
                 >
                   <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
                 </div>
               </div>
               <p className="text-xs text-slate-500 text-center flex items-center justify-center gap-2">
                 {status.step === 'analyzing' 
                   ? <><Brain size={14} className="text-purple-400 animate-pulse"/> Gemini 3 Pro is thinking...</>
                   : 'Processing...'}
               </p>
            </div>
          )}

          {/* Error State */}
          {status.step === 'error' && (
            <div className="w-full max-w-4xl mx-auto bg-red-900/20 border border-red-500/50 rounded-xl p-6 flex items-start gap-4 animate-fade-in shadow-lg">
              <div className="p-2 bg-red-500/20 rounded-full">
                <AlertCircle className="text-red-400 h-6 w-6" />
              </div>
              <div>
                <h3 className="text-red-400 font-semibold text-lg mb-1">Processing Failed</h3>
                <p className="text-red-200/80 text-sm leading-relaxed">{status.message}</p>
              </div>
            </div>
          )}

          {/* Results Section */}
          {(extractedData.length > 0) && (
            <div className={!isOnline ? "opacity-90 grayscale-[0.2]" : ""}>
               {/* Show stale data if offline */}
               <ResultsView 
                 data={extractedData} 
                 analysis={analysis} 
                 preferredFormat={preferredFormat}
                 onFormatSelected={handleFormatChange}
                 onReAnalyze={handleReAnalyze}
               />
            </div>
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