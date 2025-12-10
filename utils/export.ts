import { ExtractedItem, ExportFormat } from "../types";

export const downloadFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const convertToCSV = (data: ExtractedItem[]): string => {
  if (data.length === 0) return "";
  
  // Collect all unique keys
  const headers = Array.from(new Set(data.flatMap(Object.keys)));
  
  const csvRows = [
    headers.join(','), // Header row
    ...data.map(row => headers.map(fieldName => {
      let val = row[fieldName];
      
      if (val === null || val === undefined) return '';

      // Check for strings that look like numbers with leading zeros (e.g., "0123")
      // To preserve this in Excel, we can format it as ="0123"
      const stringVal = String(val);
      if (typeof val === 'string' && /^0\d+$/.test(stringVal)) {
        return `="""${stringVal}"""`; // Excel CSV hack: ="value"
      }

      const escaped = stringVal.replace(/"/g, '""');
      return `"${escaped}"`;
    }).join(','))
  ];

  // Add BOM for Excel UTF-8 compatibility
  return '\uFEFF' + csvRows.join('\r\n');
};

export const convertToTSV = (data: ExtractedItem[]): string => {
  if (data.length === 0) return "";
  const headers = Array.from(new Set(data.flatMap(Object.keys)));
  const rows = [
    headers.join('\t'),
    ...data.map(row => headers.map(fieldName => {
      let val = row[fieldName];
      if (val === null || val === undefined) return '';
      
      const stringVal = String(val);
      // Clean tabs and newlines
      return stringVal.replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ');
    }).join('\t'))
  ];
  return rows.join('\n');
};

export const convertToRTF = (data: ExtractedItem[]): string => {
  if (data.length === 0) return "";
  
  // Basic RTF Header
  let rtf = `{\\rtf1\\ansi\\deff0\n`;
  rtf += `\\b Extracted Data Report \\b0 \\par\\par\n`;

  data.forEach((item, index) => {
    rtf += `\\b Record ${index + 1} \\b0 \\par\n`;
    Object.entries(item).forEach(([key, value]) => {
      rtf += `\\tab ${key}: ${value} \\par\n`;
    });
    rtf += `\\par \\line \\par\n`;
  });

  rtf += `}`;
  return rtf;
};

export const convertToTXT = (data: ExtractedItem[]): string => {
  let txt = "EXTRACTED DATA REPORT\n=====================\n\n";
  data.forEach((item, index) => {
    txt += `[Record ${index + 1}]\n`;
    Object.entries(item).forEach(([key, value]) => {
      txt += `${key}: ${value}\n`;
    });
    txt += `---------------------\n`;
  });
  return txt;
};

export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  }
};

export const handleExport = (data: ExtractedItem[], format: ExportFormat, filename: string = 'data') => {
  switch (format) {
    case ExportFormat.CSV:
      downloadFile(convertToCSV(data), `${filename}.csv`, 'text/csv;charset=utf-8;');
      break;
    case ExportFormat.JSON:
      downloadFile(JSON.stringify(data, null, 2), `${filename}.json`, 'application/json');
      break;
    case ExportFormat.RTF:
      downloadFile(convertToRTF(data), `${filename}.rtf`, 'application/rtf');
      break;
    case ExportFormat.TXT:
      downloadFile(convertToTXT(data), `${filename}.txt`, 'text/plain');
      break;
  }
};