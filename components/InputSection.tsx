import React, { useState, useCallback } from 'react';
import { Upload, FileText, X, File as FileIcon, FileSpreadsheet, FileJson, Zap, Layers, Plus } from 'lucide-react';
import { FileData } from '../types';

interface InputSectionProps {
  rawText: string;
  setRawText: (text: string) => void;
  files: FileData[];
  setFiles: (files: FileData[]) => void;
  instruction: string;
  setInstruction: (text: string) => void;
  history: string[];
  onProcess: () => void;
  isProcessing: boolean;
  useFastModel: boolean;
  setUseFastModel: (useFast: boolean) => void;
}

export const InputSection: React.FC<InputSectionProps> = ({
  rawText,
  setRawText,
  files,
  setFiles,
  instruction,
  setInstruction,
  history,
  onProcess,
  isProcessing,
  useFastModel,
  setUseFastModel
}) => {
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach(processFile);
    }
  }, [files]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach(processFile);
    }
  };

  const processFile = (file: File) => {
    // If text file is small, read as text for the rawText area (only if no files exist yet to avoid confusion)
    // But for multi-file compare, we prefer treating everything as file objects
    
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64Data = base64String.split(',')[1];
      
      const newFile: FileData = {
        id: Math.random().toString(36).substring(7),
        base64: base64Data,
        mimeType: file.type || 'application/octet-stream',
        name: file.name,
        size: file.size
      };
      
      setFiles((prev) => [...(prev || []), newFile]);
    };
    reader.readAsDataURL(file);
  };

  const removeFile = (id: string) => {
    setFiles(files.filter(f => f.id !== id));
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) return <FileIcon size={24} className="text-red-400" />;
    if (mimeType.includes('csv') || mimeType.includes('sheet')) return <FileSpreadsheet size={24} className="text-green-400" />;
    if (mimeType.includes('json')) return <FileJson size={24} className="text-yellow-400" />;
    if (mimeType.startsWith('image/')) return <Layers size={24} className="text-purple-400" />;
    return <FileText size={24} className="text-blue-400" />;
  };

  return (
    <div className="space-y-6 w-full max-w-5xl mx-auto p-6 bg-slate-800 rounded-xl shadow-xl border border-slate-700">
      
      {/* Configuration / Prompt */}
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2 flex justify-between">
          <span>Extraction & Comparison Goal</span>
          <span className="text-xs text-slate-500">{instruction.length} chars</span>
        </label>
        <div className="relative">
          <input
            type="text"
            list="instruction-history"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition placeholder-slate-500 pr-10"
            placeholder={files.length > 1 
              ? "e.g., Compare File A with File B and list all matching Invoice IDs..." 
              : "e.g., Extract Invoice Number, Date, and Amount from page 1..."}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>
        <datalist id="instruction-history">
          {history.map((item, index) => (
            <option key={index} value={item} />
          ))}
        </datalist>
        <p className="text-xs text-slate-500 mt-2">
          {files.length > 1 
            ? <span className="text-blue-400 font-medium">Comparison Mode Active: The AI will look at all uploaded files together.</span>
            : "Tip: Be specific about fields. Upload multiple files to enable comparison."}
        </p>
      </div>

      {/* Input Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Multi-File Stack */}
        <div className="flex flex-col h-80">
          <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
            <Layers size={16} /> 
            Files ({files.length})
            {files.length > 1 && <span className="text-xs bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/30">Comparison Ready</span>}
          </label>
          
          <div className="flex-1 bg-slate-900 border border-slate-700 rounded-lg p-2 flex flex-col overflow-hidden relative">
            {/* File List */}
            <div className="flex-1 overflow-y-auto space-y-2 p-2 scrollbar-thin">
              {files.map((file) => (
                <div key={file.id} className="flex items-center gap-3 p-3 bg-slate-800 rounded border border-slate-700 group hover:border-blue-500/50 transition-colors">
                  <div className="shrink-0">
                    {getFileIcon(file.mimeType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{file.name}</p>
                    <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB • {file.mimeType.split('/')[1]}</p>
                  </div>
                  <button 
                    onClick={() => removeFile(file.id)}
                    className="p-1.5 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded transition"
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}

              {/* Upload Trigger Area (Always visible at bottom if space permits, or scrolling) */}
              <div 
                className={`relative border-2 border-dashed border-slate-700 hover:border-blue-500 hover:bg-slate-800/50 rounded-lg p-4 transition-colors cursor-pointer flex flex-col items-center justify-center gap-2 min-h-[100px]
                  ${dragActive ? 'border-blue-500 bg-blue-500/10' : ''}
                `}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
              >
                 <input
                    type="file"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={handleFileChange}
                    accept=".pdf,.csv,.rtf,.txt,.json,.md,image/*"
                    multiple // Enable multi-file
                  />
                  <div className="bg-slate-800 p-2 rounded-full">
                    <Plus className="h-6 w-6 text-blue-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm text-slate-300 font-medium">Add Files to Stack</p>
                    <p className="text-xs text-slate-500">Drag & Drop or Click</p>
                  </div>
              </div>
            </div>
          </div>
        </div>

        {/* Text Input Context */}
        <div className="flex flex-col h-80">
          <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
            <FileText size={16} /> Additional Context / Raw Text
          </label>
          <textarea
            className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-slate-300 resize-none focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
            placeholder="Paste text to compare against files, or specific data points you are looking for..."
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
        </div>

      </div>

      <div className="flex justify-between items-center pt-2">
        
        {/* Toggle Fast Mode */}
        <button 
          onClick={() => setUseFastModel(!useFastModel)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${useFastModel ? 'bg-yellow-500/10 border-yellow-500/50 text-yellow-400' : 'bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
          title="Use 'Flash-Lite' for faster, low-latency extraction."
        >
          <Zap size={16} className={useFastModel ? "fill-yellow-400" : ""} />
          {useFastModel ? "Turbo Mode On" : "Turbo Mode Off"}
        </button>

        <button
          onClick={onProcess}
          disabled={isProcessing}
          className={`
            px-8 py-3 rounded-lg font-semibold text-white shadow-lg transition-all flex items-center gap-2
            ${isProcessing
              ? 'bg-slate-700 cursor-not-allowed text-slate-500' 
              : 'bg-blue-600 hover:bg-blue-500 hover:shadow-blue-500/30 active:scale-95'}
          `}
        >
          {isProcessing ? 'Processing...' : (
             files.length > 1 ? <><Layers size={18} /> Compare & Extract</> : 'Extract Data'
          )}
        </button>
      </div>
    </div>
  );
};