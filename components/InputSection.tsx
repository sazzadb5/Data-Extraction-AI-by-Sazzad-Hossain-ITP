import React, { useState, useCallback } from 'react';
import { Upload, FileText, Image as ImageIcon, X, File as FileIcon } from 'lucide-react';
import { FileData } from '../types';

interface InputSectionProps {
  rawText: string;
  setRawText: (text: string) => void;
  fileData: FileData | null;
  setFileData: (data: FileData | null) => void;
  instruction: string;
  setInstruction: (text: string) => void;
  onProcess: () => void;
  isProcessing: boolean;
}

export const InputSection: React.FC<InputSectionProps> = ({
  rawText,
  setRawText,
  fileData,
  setFileData,
  instruction,
  setInstruction,
  onProcess,
  isProcessing
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
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = (file: File) => {
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'];
    
    if (file.type === "text/plain") {
      const reader = new FileReader();
      reader.onload = (e) => {
        setRawText((e.target?.result as string) || "");
      };
      reader.readAsText(file);
    } else if (validTypes.some(type => file.type.startsWith(type.split('/')[0]) || file.type === type)) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        // Remove data URL prefix for API
        const base64Data = base64String.split(',')[1];
        setFileData({
          base64: base64Data,
          mimeType: file.type,
          name: file.name
        });
      };
      reader.readAsDataURL(file);
    } else {
      alert("Supported formats: PDF Documents, Images (PNG, JPG), or Plain Text.");
    }
  };

  const renderFilePreview = () => {
    if (!fileData) return null;

    const isImage = fileData.mimeType.startsWith('image/');
    
    return (
      <div className="relative w-full h-full p-4 flex flex-col items-center justify-center bg-slate-800 rounded">
        {isImage ? (
          <img 
            src={`data:${fileData.mimeType};base64,${fileData.base64}`} 
            alt="Preview" 
            className="max-w-full max-h-[160px] object-contain rounded shadow-md"
          />
        ) : (
          <div className="flex flex-col items-center text-slate-300">
            <FileIcon size={64} className="text-red-400 mb-2" />
            <span className="text-sm font-medium text-center truncate max-w-[200px]">{fileData.name}</span>
            <span className="text-xs text-slate-500 uppercase mt-1">PDF Document</span>
          </div>
        )}
        
        <button 
          onClick={(e) => {
            e.preventDefault();
            setFileData(null);
          }}
          className="absolute top-2 right-2 p-1.5 bg-red-500/80 hover:bg-red-600 text-white rounded-full transition shadow-lg"
        >
          <X size={16} />
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto p-6 bg-slate-800 rounded-xl shadow-xl border border-slate-700">
      
      {/* Configuration / Prompt */}
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">
          Extraction Goal <span className="text-slate-500">(What do you want to extract?)</span>
        </label>
        <input
          type="text"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
          placeholder="e.g., Extract name, email, and invoice amount from this PDF..."
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

      {/* Input Area */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Text Input */}
        <div className="flex flex-col h-64">
          <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
            <FileText size={16} /> Paste Text
          </label>
          <textarea
            className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-slate-300 resize-none focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
            placeholder="Paste text here or upload a file ->"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
        </div>

        {/* File/Image Upload */}
        <div className="flex flex-col h-64">
          <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
            <Upload size={16} /> Upload Document / Image
          </label>
          <div
            className={`flex-1 relative flex flex-col items-center justify-center border-2 border-dashed rounded-lg transition-colors cursor-pointer overflow-hidden
              ${dragActive ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-600'}
            `}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <input
              type="file"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              onChange={handleFileChange}
              accept=".pdf,image/png,image/jpeg,image/webp,.txt"
            />
            
            {fileData ? renderFilePreview() : (
              <div className="text-center p-4">
                <div className="bg-slate-800 p-3 rounded-full inline-block mb-3">
                  <Upload className="h-8 w-8 text-blue-400" />
                </div>
                <p className="text-sm text-slate-300 font-medium">Click to upload or drag & drop</p>
                <p className="text-xs text-slate-500 mt-2">Supports Large PDF (5K+ pages), PNG, JPG</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={onProcess}
          disabled={isProcessing || (!rawText && !fileData)}
          className={`
            px-8 py-3 rounded-lg font-semibold text-white shadow-lg transition-all
            ${isProcessing || (!rawText && !fileData)
              ? 'bg-slate-700 cursor-not-allowed text-slate-500' 
              : 'bg-blue-600 hover:bg-blue-500 hover:shadow-blue-500/30 active:scale-95'}
          `}
        >
          {isProcessing ? 'Processing with Gemini 2.5...' : 'Extract Data'}
        </button>
      </div>
    </div>
  );
};