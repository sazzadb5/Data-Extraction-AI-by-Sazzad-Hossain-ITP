import React, { useMemo, useState } from 'react';
import { Download, Table, BarChart2, PieChart, Activity, Copy, Check, FileSpreadsheet, FileText, Lightbulb, Star, RefreshCw, Brain } from 'lucide-react';
import { ExtractedItem, AnalysisResult, ExportFormat } from '../types';
import { handleExport, convertToTSV, copyToClipboard } from '../utils/export';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface ResultsViewProps {
  data: ExtractedItem[];
  analysis: AnalysisResult | null;
  preferredFormat: ExportFormat;
  onFormatSelected: (format: ExportFormat) => void;
  onReAnalyze: () => void;
}

export const ResultsView: React.FC<ResultsViewProps> = ({ 
  data, 
  analysis, 
  preferredFormat, 
  onFormatSelected,
  onReAnalyze
}) => {
  const [copied, setCopied] = useState(false);

  // Dynamically get headers from the first few items
  const headers = useMemo(() => {
    if (!data || data.length === 0) return [];
    // Ensure we don't crash on null items in the array (though service layer filters them now)
    return Array.from(new Set(data.flatMap(row => row ? Object.keys(row) : [])));
  }, [data]);

  // Prepare chart data if numeric values exist
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    // Safe header check
    if (headers.length === 0) return [];

    // Find a numeric key to visualize
    const numericKey = headers.find(h => data[0] && typeof data[0][h] === 'number');
    const labelKey = headers.find(h => data[0] && typeof data[0][h] === 'string' && h !== numericKey) || headers[0];
    
    if (!numericKey) return [];

    return data.slice(0, 10).map(item => ({
      name: String(item[labelKey] || 'Unknown').substring(0, 10),
      value: Number(item[numericKey]) || 0
    }));
  }, [data, headers]);

  const handleCopy = async () => {
    const tsv = convertToTSV(data);
    const success = await copyToClipboard(tsv);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const onExport = (format: ExportFormat) => {
    handleExport(data, format);
    onFormatSelected(format);
  };

  if (!data || data.length === 0) return null;

  return (
    <div className="w-full max-w-6xl mx-auto space-y-8 animate-fade-in-up">
      
      {/* Analysis Section */}
      {analysis ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 col-span-1 md:col-span-2 relative group">
            <div className="flex justify-between items-start mb-2">
                <h3 className="text-lg font-semibold text-blue-400 flex items-center gap-2">
                <Activity size={20} /> AI Analysis
                </h3>
                <button 
                    onClick={onReAnalyze}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-700/50 hover:bg-slate-700 text-slate-300 text-xs rounded transition border border-slate-600 hover:text-white"
                    title="Regenerate analysis with Gemini 3 Pro"
                >
                    <RefreshCw size={12} /> Regenerate
                </button>
            </div>
            <p className="text-slate-300 text-sm leading-relaxed mb-4">{analysis.summary}</p>
            
            <div className="flex flex-wrap gap-2 mb-4">
               {analysis.keyEntities.map((entity, i) => (
                 <span key={i} className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300 border border-slate-600">
                   {entity}
                 </span>
               ))}
            </div>

            <div className="flex items-center gap-2 text-sm">
               <span className="text-slate-400">Sentiment:</span>
               <span className={`px-2 py-0.5 rounded uppercase font-bold text-xs
                 ${analysis.sentiment === 'positive' ? 'bg-green-500/20 text-green-400' : 
                   analysis.sentiment === 'negative' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}
               `}>
                 {analysis.sentiment}
               </span>
            </div>
            
            {/* Heuristic Analysis */}
            {analysis.heuristicAnalysis && analysis.heuristicAnalysis.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-700">
                 <h4 className="text-sm font-semibold text-yellow-500 mb-2 flex items-center gap-2">
                   <Lightbulb size={16} /> Heuristic Observations
                 </h4>
                 <ul className="space-y-1">
                   {analysis.heuristicAnalysis.map((item, i) => (
                     <li key={i} className="text-xs text-slate-400 italic">• {item}</li>
                   ))}
                 </ul>
              </div>
            )}
          </div>

          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 flex flex-col justify-center">
             <h3 className="text-sm font-semibold text-slate-400 mb-3">Actionable Insights</h3>
             <ul className="space-y-2">
               {analysis.suggestedActions.map((action, i) => (
                 <li key={i} className="text-xs text-slate-300 flex items-start gap-2">
                   <span className="text-blue-500 mt-0.5">•</span> {action}
                 </li>
               ))}
             </ul>
          </div>
        </div>
      ) : (
        <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-3">
                 <div className="p-2 bg-purple-500/10 rounded-lg">
                    <Brain size={24} className="text-purple-400" />
                 </div>
                 <div>
                    <h3 className="text-base font-medium text-slate-200">Deep Analysis Available</h3>
                    <p className="text-xs text-slate-400">Use Gemini 3 Pro Thinking Mode to analyze this dataset.</p>
                 </div>
            </div>
            <button 
                onClick={onReAnalyze} 
                className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg transition text-sm font-medium shadow-lg shadow-purple-500/20"
            >
                <Brain size={16} /> Analyze Data
            </button>
        </div>
      )}

      {/* Chart Section (Conditional) */}
      {chartData.length > 0 && (
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 h-80">
          <h3 className="text-lg font-semibold text-slate-300 mb-4 flex items-center gap-2">
            <BarChart2 size={20} /> Data Visualization
          </h3>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#f8fafc' }}
                cursor={{ fill: '#334155', opacity: 0.4 }}
              />
              <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Data Table Section */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-700 flex flex-wrap justify-between items-center gap-4 bg-slate-800/50 backdrop-blur">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Table size={20} /> Extracted Data <span className="text-sm font-normal text-slate-500">({data.length} records)</span>
          </h3>
          
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={handleCopy}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition
                ${copied ? 'bg-green-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}
              `}
              title="Copy table to clipboard for Excel"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
            
            <div className="w-px h-6 bg-slate-600 mx-1 hidden sm:block"></div>

             {/* Export Buttons - Highlight preferred */}
             {[
               { format: ExportFormat.CSV, label: 'Excel / CSV', icon: FileSpreadsheet },
               { format: ExportFormat.TXT, label: 'Text', icon: FileText },
               { format: ExportFormat.RTF, label: 'RTF', icon: Download },
               { format: ExportFormat.JSON, label: 'JSON', icon: Download }
             ].map((btn) => {
               const isPreferred = preferredFormat === btn.format;
               return (
                 <button
                   key={btn.format}
                   onClick={() => onExport(btn.format)}
                   className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition relative group
                     ${isPreferred 
                       ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 ring-1 ring-blue-400' 
                       : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}
                   `}
                   title={isPreferred ? "Default Format" : "Export"}
                 >
                   <btn.icon size={12} /> {btn.label}
                   {isPreferred && (
                     <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-yellow-400 rounded-full border border-slate-800 flex items-center justify-center">
                       <Star size={6} className="text-slate-900 fill-slate-900" />
                     </div>
                   )}
                 </button>
               );
             })}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-400">
            <thead className="bg-slate-900/50 text-slate-200 uppercase text-xs font-semibold">
              <tr>
                <th className="px-6 py-3 w-12 text-center">#</th>
                {headers.map(h => (
                  <th key={h} className="px-6 py-3 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.map((row, idx) => (
                <tr key={idx} className="hover:bg-slate-700/30 transition-colors">
                  <td className="px-6 py-4 text-center font-mono text-slate-600">{idx + 1}</td>
                  {headers.map(h => (
                    <td key={`${idx}-${h}`} className="px-6 py-4 max-w-xs truncate text-slate-300">
                      {row && row[h] !== null && row[h] !== undefined ? String(row[h]) : <span className="text-slate-600">-</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};