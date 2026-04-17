/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { UploadCloud, FileImage, Loader2, Table as TableIcon, AlertCircle, Download, ZoomIn, ZoomOut, Maximize, CheckCircle2, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { motion, AnimatePresence } from "motion/react";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface SubjectGrade {
  subjectName: string;
  subjectCode?: string;
  obtained: string;
}

interface StudentData {
  studentName: string;
  rollNumber?: string;
  yearOfExam?: string;
  stateBoard?: string;
  subjects: SubjectGrade[];
  totalMarksObtained?: string;
  percentage?: string;
  result?: string;
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [data, setData] = useState<StudentData[] | null>(null);
  const [subjectMaxMarks, setSubjectMaxMarks] = useState<Record<string, string>>({});
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let timer: NodeJS.Timeout;
    if (retryAfter !== null && retryAfter > 0) {
      timer = setTimeout(() => {
        setRetryAfter(retryAfter - 1);
      }, 1000);
    } else if (retryAfter === 0) {
      setRetryAfter(null);
    }
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const applyMathRules = (student: StudentData, maxMarksMap: Record<string, string>): StudentData => {
    let calcObtained = 0;
    let calcMax = 0;
    let validMath = false;

    // 1. Try to calculate from individual subjects
    student.subjects?.forEach(sub => {
       if (!sub.obtained) return;
       const obtainedValue = parseFloat(sub.obtained.replace(/[^\d.]/g, ''));
       // Default to "100" if no max mark is found in the map
       const maxStr = maxMarksMap[sub.subjectName] || "100";
       const maxValue = parseFloat(maxStr.replace(/[^\d.]/g, ''));
       
       if (!isNaN(obtainedValue)) {
          calcObtained += obtainedValue;
          if (!isNaN(maxValue)) {
             calcMax += maxValue;
             validMath = true;
          }
       }
    });

    // 2. Fallback check for Total Marks formatting if subject math is incomplete
    if (!validMath || calcMax === 0) {
      if (student.totalMarksObtained && student.totalMarksObtained.includes('/')) {
        const parts = student.totalMarksObtained.split('/');
        const rawObtained = parseFloat(parts[0].replace(/[^\d.]/g, ''));
        const rawMax = parseFloat(parts[1].replace(/[^\d.]/g, ''));
        if (!isNaN(rawObtained) && !isNaN(rawMax)) {
          calcObtained = rawObtained;
          calcMax = rawMax;
          validMath = true;
        }
      }
    }

    let currentPercent: number | null = null;

    if (validMath && calcMax > 0) {
      student.totalMarksObtained = `${calcObtained}/${calcMax}`;
      const computedPercent = (calcObtained / calcMax) * 100;
      student.percentage = `${computedPercent.toFixed(2)}%`;
      currentPercent = computedPercent;
    } else {
      // If we still don't have a valid percentage from math, try to parse what AI gave us
      if (student.percentage) {
        currentPercent = parseFloat(student.percentage.replace(/[^\d.]/g, ''));
      }
    }

    if (currentPercent !== null && !isNaN(currentPercent)) {
      student.result = currentPercent >= 35 ? 'Pass' : 'Fail';
    }
    
    return student;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []) as File[];
    if (selectedFiles.length > 0) {
      processFiles(selectedFiles);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files || []) as File[];
    const filtered = droppedFiles.filter(
      file => file.type.startsWith('image/') || file.type === 'application/pdf'
    );
    if (filtered.length > 0) {
      processFiles(filtered);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const processFiles = async (newFiles: File[]) => {
    setFiles(newFiles);
    setPreviewUrl(URL.createObjectURL(newFiles[0]));
    setNumPages(null);
    setError(null);
    setData(null);
    setIsProcessing(true);
    setProgress(0);
    setProcessingStatus(`Initializing...`);

    let allExtracted: StudentData[] = [];
    const internalMaxMarks = { ...subjectMaxMarks };

    try {
      setRetryAfter(null);
      let count = 0;
      for (const file of newFiles) {
        count++;
        setProcessingStatus(`Processing file ${count} of ${newFiles.length}: ${file.name}`);
        setProgress(Math.round(((count - 0.5) / newFiles.length) * 100));
        
        let base64Clean: string;
        let mimeType: string;

        if (file.type === 'application/pdf') {
          const base64Data = await fileToBase64(file);
          base64Clean = base64Data.split(',')[1];
          mimeType = 'application/pdf';
        } else {
          const compressedImageBase64 = await preprocessImage(file);
          base64Clean = compressedImageBase64.split(',')[1];
          mimeType = compressedImageBase64.split(';')[0].split(':')[1] || file.type;
        }
        
        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite-preview",
          contents: [
            {
              inlineData: {
                data: base64Clean,
                mimeType: mimeType
              }
            },
            "Carefully analyze this document, which may contain one or multiple marksheets or report cards. Extract the following information for EACH student found: 'studentName', 'rollNumber', 'yearOfExam' (EXTRACT ONLY THE 4-DIGIT YEAR, e.g., '2023'. Ignore months, days, or full dates), 'stateBoard', 'totalMarksObtained' (obtained/max), 'percentage', and 'result'. For each specific 'subject', capture the 'subjectName', 'subjectCode', the 'obtained' marks, and the 'max' marks (maximum possible for that subject). Assume 'max' is '100' if not explicitly stated on the document. Organise everything as a JSON array of student objects. Do not invent data."
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  studentName: { type: Type.STRING, description: "The full name of the student" },
                  rollNumber: { type: Type.STRING, description: "Student roll number or ID" },
                  yearOfExam: { type: Type.STRING, description: "ONLY the 4-digit year of the exam (e.g., '2024'). DO NOT include months or full dates." },
                  stateBoard: { type: Type.STRING, description: "The name of the educational board or institution" },
                  totalMarksObtained: { type: Type.STRING, description: "Total marks in 'obtained/max' format" },
                  percentage: { type: Type.STRING, description: "Final percentage (e.g. '85%')" },
                  result: { type: Type.STRING, description: "Final result (e.g. Pass/Fail)" },
                  subjects: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        subjectName: { type: Type.STRING },
                        subjectCode: { type: Type.STRING },
                        obtained: { type: Type.STRING },
                        max: { type: Type.STRING }
                      }
                    }
                  }
                }
              }
            }
          }
        });
        
        const responseText = response.text;
        if (responseText) {
          const parsedData: any[] = JSON.parse(responseText);
          
          parsedData.forEach(student => {
            student.subjects?.forEach((sub: any) => {
              if (sub.max && !internalMaxMarks[sub.subjectName]) {
                internalMaxMarks[sub.subjectName] = sub.max;
              }
            });
          });
          
          allExtracted = [...allExtracted, ...parsedData];
        }
        setProgress(Math.round((count / newFiles.length) * 100));
      }
      
      setSubjectMaxMarks(internalMaxMarks);
      setProcessingStatus("Finalizing data...");
      const formalizedData = allExtracted.map(student => {
        // Cleanup year: Extract only the 4-digit year if the AI included a full date or month
        if (student.yearOfExam) {
          const yearMatch = student.yearOfExam.match(/\d{4}/);
          if (yearMatch) student.yearOfExam = yearMatch[0];
        }
        return applyMathRules(student, internalMaxMarks);
      });
      setData(formalizedData);
      setProgress(100);
      
    } catch (err: any) {
      console.error(err);
      let errorMsg = err.message || "Failed to process the files. Please ensure they are marksheets.";
      
      try {
        // Attempt to parse out structured API errors (like 429 Quota)
        // Use s flag for dotAll to handle multi-line JSON strings
        const jsonMatch = typeof errorMsg === 'string' ? errorMsg.match(/\{.*?\}/s) : null;
        
        if (jsonMatch) {
          const apiErr = JSON.parse(jsonMatch[0]);
          if (apiErr.error?.code === 429 || apiErr.error?.status === 'RESOURCE_EXHAUSTED' || apiErr.error?.message?.toLowerCase().includes('quota')) {
            const innerMsg = apiErr.error?.message?.toLowerCase() || "";
            const isDaily = innerMsg.includes('daily') || innerMsg.includes('day') || innerMsg.includes('project');
            
            if (isDaily) {
              errorMsg = "Daily API Quota Exhausted. You have reached the limit for today (20 requests per project). Please try again tomorrow or use a different API key.";
              setRetryAfter(null);
            } else {
              errorMsg = "API Rate Limit reached. Please wait a moment and try again.";
              const delay = apiErr.error?.details?.find((d: any) => d.retryDelay)?.retryDelay;
              if (delay) {
                const seconds = parseInt(delay.replace('s', ''));
                if (!isNaN(seconds)) setRetryAfter(seconds);
              } else {
                setRetryAfter(10);
              }
            }
          }
        } else if (typeof errorMsg === 'string' && (errorMsg.toLowerCase().includes('quota') || errorMsg.toLowerCase().includes('exhausted'))) {
          // Fallback if JSON parsing fails but error contains quota keywords
          errorMsg = "API Quota/Rate Limit reached. The Gemini API Free Tier has strict limits. Please wait a moment and try again.";
          setRetryAfter(15);
        }
      } catch (pErr) {
        console.error("Error parsing API error", pErr);
      }

      setError(errorMsg);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCellChange = (studentIdx: number, field: keyof StudentData, value: string) => {
    if (!data) return;
    const newData = [...data];
    newData[studentIdx] = { ...newData[studentIdx], [field]: value };
    newData[studentIdx] = applyMathRules(newData[studentIdx], subjectMaxMarks);
    setData(newData);
  };

  const handleSubjectChange = (studentIdx: number, subjectName: string, value: string) => {
    if (!data) return;
    const newData = [...data];
    const student = { ...newData[studentIdx] };
    const subjects = [...(student.subjects || [])];
    
    const subIdx = subjects.findIndex(s => s.subjectName === subjectName);
    if (subIdx >= 0) {
      subjects[subIdx] = { ...subjects[subIdx], obtained: value };
    } else {
      subjects.push({ subjectName, obtained: value });
    }
    
    student.subjects = subjects;
    newData[studentIdx] = applyMathRules(student, subjectMaxMarks);
    setData(newData);
  };

  const handleMaxMarkChange = (subjectName: string, value: string) => {
    const newMaxMarks = { ...subjectMaxMarks, [subjectName]: value };
    setSubjectMaxMarks(newMaxMarks);
    
    if (data) {
      const newData = data.map(student => applyMathRules(student, newMaxMarks));
      setData(newData);
    }
  };

  const allSubjects: string[] = Array.from(
    new Set(data?.flatMap(s => s.subjects?.map(sub => sub.subjectName) || []) || [])
  ) as string[];

  const subjectCodes: Record<string, string> = {};
  if (data) {
    data.forEach(student => {
      student.subjects?.forEach(sub => {
        if (sub.subjectCode && !subjectCodes[sub.subjectName]) {
          subjectCodes[sub.subjectName] = sub.subjectCode;
        }
      });
    });
  }

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getSortValue = (student: StudentData, key: string) => {
    if (key.startsWith('subject:')) {
      const subjectName = key.replace('subject:', '');
      const gradeObj = student.subjects?.find(s => s.subjectName === subjectName);
      if (!gradeObj) return -1;
      const val = parseFloat(gradeObj.obtained.replace(/[^\d.]/g, ''));
      return isNaN(val) ? -1 : val;
    }
    
    const val = (student as any)[key];
    if (key === 'percentage') return parseFloat(val?.replace(/[^\d.]/g, '') || '0');
    if (key === 'totalMarksObtained') {
      const parts = val?.split('/');
      return parts ? parseFloat(parts[0].replace(/[^\d.]/g, '')) || 0 : 0;
    }
    return (val || '').toString().toLowerCase();
  };

  const sortedData = React.useMemo(() => {
    if (!data) return null;
    let items = [...data];
    if (sortConfig !== null) {
      items.sort((a, b) => {
        const aVal = getSortValue(a, sortConfig.key);
        const bVal = getSortValue(b, sortConfig.key);
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return items;
  }, [data, sortConfig]);

  const SortIcon = ({ columnKey }: { columnKey: string }) => {
    if (!sortConfig || sortConfig.key !== columnKey) return <ChevronsUpDown size={12} className="text-zinc-300 ml-1 shrink-0" />;
    return sortConfig.direction === 'asc' 
      ? <ChevronUp size={12} className="text-blue-600 ml-1 shrink-0" /> 
      : <ChevronDown size={12} className="text-blue-600 ml-1 shrink-0" />;
  };

  const exportToCSV = () => {
    const csvData = sortedData || data;
    if (!csvData) return;
    const headers = [
      'Student Name', 'Roll Number', 'Year', 'State Board', 
      ...allSubjects.map(s => subjectCodes[s] ? `${s} (${subjectCodes[s]})` : s), 
      'Total Marks', 'Percentage', 'Result'
    ];
    const rows: string[][] = [headers];
    csvData.forEach(student => {
      const row: string[] = [
        student.studentName || '',
        student.rollNumber || '',
        student.yearOfExam || '',
        student.stateBoard || ''
      ];
      allSubjects.forEach(subject => {
         const gradeObj = student.subjects?.find(s => s.subjectName === subject);
         row.push(gradeObj ? gradeObj.obtained : '');
      });
      row.push(student.totalMarksObtained || '');
      row.push(student.percentage || '');
      row.push(student.result || '');

      rows.push(row);
    });
    
    const csvContent = rows.map(e => e.map(item => `"${(item || '').replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "extracted_grades.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 pb-20">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center">
              <TableIcon size={18} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Grade2<span className="text-blue-600">Data</span></h1>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 mt-12 space-y-12">
        <div className="max-w-2xl mx-auto text-center space-y-4">
          <h2 className="text-4xl font-semibold tracking-tight text-zinc-900">
            Automatic Marksheet Scanning System
          </h2>
          <p className="text-lg text-zinc-600">
            Upload an image or PDF of the Marksheet
          </p>
        </div>

        {!previewUrl && (
          <div 
            className="max-w-2xl mx-auto bg-white border-2 border-dashed border-zinc-300 rounded-2xl p-12 text-center hover:bg-zinc-50 transition-colors cursor-pointer group"
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
              <UploadCloud size={28} />
            </div>
            <h3 className="text-lg font-medium text-zinc-900 mb-2">Click to upload or drag and drop</h3>
            <p className="text-sm text-zinc-500 mb-6">Supports JPG, PNG, WEBP, PDF</p>
            <button className="px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors inline-flex items-center gap-2">
               Select File
            </button>
            <input 
              type="file" 
              className="hidden" 
              ref={fileInputRef} 
              accept="image/*,application/pdf" 
              multiple
              onChange={handleFileChange}
            />
          </div>
        )}

        {previewUrl && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-4 space-y-4">
              <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden shadow-sm">
                <div className="p-4 border-b border-zinc-100 flex items-center justify-between bg-zinc-50/50">
                  <span className="font-medium flex items-center gap-2 text-sm text-zinc-700">
                    <FileImage size={16} className="text-zinc-400" />
                    {files.length > 1 ? `Batch Processed (${files.length} items)` : (files[0]?.type === 'application/pdf' ? 'Original Document' : 'Original Image')}
                  </span>
                  <button 
                    onClick={() => {
                      setPreviewUrl(null);
                      setFiles([]);
                      setData(null);
                      setError(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Upload New
                  </button>
                </div>
                <div className="p-0 bg-zinc-100 flex items-center justify-center min-h-[400px] overflow-hidden relative">
                  <TransformWrapper initialScale={1} minScale={0.5} maxScale={5} centerOnInit>
                    {({ zoomIn, zoomOut, resetTransform }) => (
                      <>
                        <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 bg-white/90 p-1.5 rounded-lg shadow-md border border-zinc-200">
                          <button onClick={() => zoomIn()} className="p-1.5 text-zinc-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Zoom In">
                            <ZoomIn size={18} />
                          </button>
                          <button onClick={() => zoomOut()} className="p-1.5 text-zinc-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Zoom Out">
                            <ZoomOut size={18} />
                          </button>
                          <button onClick={() => resetTransform()} className="p-1.5 text-zinc-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Reset Zoom">
                            <Maximize size={18} />
                          </button>
                        </div>
                        <TransformComponent wrapperClass="w-full h-full min-h-[400px] cursor-grab active:cursor-grabbing" contentClass="w-full h-full flex items-center justify-center">
                          {files[0]?.type === 'application/pdf' ? (
                            <div className="w-full flex-col items-center flex gap-4 p-4">
                              <Document 
                                file={previewUrl} 
                                onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                                loading={<p className="text-sm text-zinc-500 py-10">Loading PDF document...</p>}
                                className="flex flex-col items-center gap-4"
                              >
                                {Array.from(new Array(numPages || 0), (el, index) => (
                                   <div key={`page_${index + 1}`} className="shadow-md rounded overflow-hidden bg-white">
                                     <Page 
                                       pageNumber={index + 1} 
                                       renderTextLayer={false} 
                                       renderAnnotationLayer={false} 
                                       width={320}
                                     />
                                   </div>
                                ))}
                              </Document>
                            </div>
                          ) : (
                            <div className="p-4 flex items-center justify-center">
                              <img 
                                 src={previewUrl!} 
                                 alt="Marksheet preview" 
                                 className="max-w-full max-h-[500px] rounded shadow-sm select-none"
                                 referrerPolicy="no-referrer"
                                 draggable={false}
                              />
                            </div>
                          )}
                        </TransformComponent>
                      </>
                    )}
                  </TransformWrapper>
                </div>
              </div>
            </div>

            <div className="lg:col-span-8">
              <AnimatePresence mode="wait">
                {isProcessing && (
                  <motion.div 
                    key="processing"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="bg-white rounded-2xl border border-zinc-200 border-dashed p-10 flex flex-col items-center justify-center text-center space-y-6 h-full min-h-[400px]"
                  >
                    <div className="relative">
                      <Loader2 size={48} className="animate-spin text-blue-600" />
                      <div className="absolute inset-0 flex items-center justify-center">
                         <span className="text-[10px] font-bold text-blue-700">{progress}%</span>
                      </div>
                    </div>
                    
                    <div className="space-y-4 w-full max-w-sm">
                      <div className="space-y-1">
                        <p className="text-zinc-900 font-semibold text-sm">{processingStatus}</p>
                        <div className="h-2 w-full bg-zinc-100 rounded-full overflow-hidden">
                           <motion.div 
                             className="h-full bg-blue-600"
                             initial={{ width: 0 }}
                             animate={{ width: `${progress}%` }}
                             transition={{ duration: 0.3 }}
                           />
                        </div>
                      </div>
                      <p className="text-xs text-zinc-400">Scanning marksheet & extracting grades. This can take a few moments depending on the complexity.</p>
                    </div>
                  </motion.div>
                )}

                {error && !isProcessing && (
                  <motion.div 
                    key="error"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-red-50 border border-red-200 rounded-2xl p-6 flex flex-col items-center justify-center space-y-4 text-center"
                  >
                    <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                      <AlertCircle size={24} />
                    </div>
                    <div>
                       <h3 className="text-red-900 font-medium mb-1">Processing Error</h3>
                       <p className="text-red-700 text-sm max-w-md">{error}</p>
                    </div>
                    
                    {error.includes('Quota') && (
                      <div className="bg-white/50 border border-red-100 rounded-xl p-4 text-left max-w-md">
                        <h4 className="text-xs font-bold text-red-900 uppercase tracking-wider mb-2">Why is this happening?</h4>
                        <ul className="text-[11px] text-red-800 space-y-1 list-disc pl-4">
                          <li>The **Free Tier** of the Gemini API limits requests to **20 per project per day**.</li>
                          <li>Batching multiple files counts towards this daily limit.</li>
                          <li>If you see "Daily Quota Exhausted," most projects reset around midnight Pacific Time.</li>
                        </ul>
                      </div>
                    )}

                    <button 
                      disabled={retryAfter !== null}
                      onClick={() => files.length > 0 && processFiles(files)}
                      className={`px-4 py-2 font-medium rounded-lg text-sm transition-colors mt-2 ${
                        retryAfter !== null 
                        ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed' 
                        : 'bg-red-100 hover:bg-red-200 text-red-700'
                      }`}
                    >
                      {retryAfter !== null ? `Retry in ${retryAfter}s...` : 'Try Again'}
                    </button>
                  </motion.div>
                )}

                {data && !isProcessing && (
                  <motion.div 
                    key="results"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden"
                  >
                  <div className="p-5 border-b border-zinc-100 flex items-center justify-between flex-wrap gap-4">
                     <div className="flex items-center gap-3">
                       <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                          <TableIcon size={18} className="text-blue-600" />
                          Extracted Results
                       </h3>
                       <span className="text-xs font-medium px-2.5 py-1 bg-green-100 text-green-700 rounded-full">
                          {data.length} student{data.length !== 1 ? 's' : ''} found
                       </span>
                     </div>
                     <div className="flex items-center gap-2">
                        <button 
                          onClick={exportToCSV}
                          className="px-3 py-1.5 bg-white border border-zinc-200 hover:bg-zinc-50 text-sm font-medium text-zinc-700 rounded-md transition-colors flex items-center gap-1.5 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        >
                          <Download size={14} />
                          CSV
                        </button>
                     </div>
                  </div>
                  
                  {data.length === 0 ? (
                    <div className="p-12 text-center text-zinc-500">
                      No students or grades could be found in this image.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse min-w-[600px]">
                        <thead>
                          <tr className="bg-zinc-50 border-b border-zinc-200 text-xs uppercase tracking-wider text-zinc-500 font-medium select-none">
                            <th 
                              className="py-3 px-5 border-r border-zinc-200 min-w-48 sticky left-0 bg-zinc-50 shadow-[1px_0_0_0_rgb(228_228_231)] z-10 cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('studentName')}
                            >
                              <div className="flex items-center">Student Name <SortIcon columnKey="studentName" /></div>
                            </th>
                            <th 
                              className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('rollNumber')}
                            >
                              <div className="flex items-center">Roll Number <SortIcon columnKey="rollNumber" /></div>
                            </th>
                            <th 
                              className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('yearOfExam')}
                            >
                              <div className="flex items-center">Year <SortIcon columnKey="yearOfExam" /></div>
                            </th>
                            <th 
                              className="py-3 px-5 whitespace-nowrap min-w-48 cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('stateBoard')}
                            >
                              <div className="flex items-center">State Board <SortIcon columnKey="stateBoard" /></div>
                            </th>
                            {allSubjects.map((subject, idx) => (
                              <th 
                                key={idx} 
                                className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                                onClick={() => requestSort(`subject:${subject}`)}
                              >
                                <div className="flex items-center flex-wrap">
                                  <span>{subject}</span>
                                  <SortIcon columnKey={`subject:${subject}`} />
                                </div>
                                {subjectCodes[subject] && (
                                  <div className="text-[10px] text-zinc-400 normal-case tracking-normal mt-0.5">
                                    {subjectCodes[subject]}
                                  </div>
                                )}
                              </th>
                            ))}
                            <th 
                              className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('totalMarksObtained')}
                            >
                              <div className="flex items-center">Total Marks <SortIcon columnKey="totalMarksObtained" /></div>
                            </th>
                            <th 
                              className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('percentage')}
                            >
                              <div className="flex items-center">Percentage <SortIcon columnKey="percentage" /></div>
                            </th>
                            <th 
                              className="py-3 px-5 whitespace-nowrap cursor-pointer hover:text-blue-600 transition-colors"
                              onClick={() => requestSort('result')}
                            >
                              <div className="flex items-center">Result <SortIcon columnKey="result" /></div>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 text-sm">
                           {/* Add Max Marks row at the top of results */}
                           <tr className="bg-zinc-50/80 font-medium">
                              <td className="py-3 px-5 border-r border-zinc-100 sticky left-0 bg-zinc-50/80 shadow-[1px_0_0_0_rgb(244_244_245)] z-10 text-zinc-500 text-[10px] uppercase tracking-wider italic">
                                Marks Out Of / Max Marks
                              </td>
                              <td className="p-3"></td>
                              <td className="p-3"></td>
                              <td className="p-3"></td>
                              {allSubjects.map((subject, subIdx) => (
                                <td key={`max_${subIdx}`} className="p-0">
                                  <div className="h-full w-full py-2 px-3">
                                    <input 
                                      value={subjectMaxMarks[subject] || ''}
                                      onChange={(e) => handleMaxMarkChange(subject, e.target.value)}
                                      placeholder="Set Max"
                                      className="w-full min-w-[80px] py-1 px-2 rounded bg-white text-zinc-900 border border-zinc-200 font-bold focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-center placeholder:font-normal placeholder:italic text-xs"
                                    />
                                  </div>
                                </td>
                              ))}
                              <td colSpan={3} className="bg-zinc-100/30"></td>
                           </tr>

                           {(sortedData || data).map((student, idx) => (
                            <tr key={idx} className="hover:bg-zinc-50/50 transition-colors group">
                              <td className="p-0 border-r border-zinc-100 sticky left-0 bg-white shadow-[1px_0_0_0_rgb(244_244_245)] z-10">
                                <input 
                                  value={student.studentName || ''}
                                  onChange={(e) => handleCellChange(idx, 'studentName', e.target.value)}
                                  placeholder="-"
                                  className="w-full h-full py-3 px-5 bg-transparent border-[1.5px] border-transparent focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 font-medium text-zinc-900 outline-none transition-all"
                                />
                              </td>
                              <td className="p-0">
                                <input 
                                  value={student.rollNumber || ''}
                                  onChange={(e) => handleCellChange(idx, 'rollNumber', e.target.value)}
                                  placeholder="-"
                                  className="w-full h-full py-3 px-5 bg-transparent border-[1.5px] border-transparent focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 text-zinc-600 outline-none transition-all"
                                />
                              </td>
                              <td className="p-0 whitespace-nowrap">
                                <input 
                                  value={student.yearOfExam || ''}
                                  onChange={(e) => handleCellChange(idx, 'yearOfExam', e.target.value)}
                                  placeholder="-"
                                  className="w-full h-full py-3 px-5 bg-transparent border-[1.5px] border-transparent focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 text-zinc-600 outline-none transition-all"
                                />
                              </td>
                              <td className="p-0">
                                <input 
                                  value={student.stateBoard || ''}
                                  onChange={(e) => handleCellChange(idx, 'stateBoard', e.target.value)}
                                  placeholder="-"
                                  className="w-full h-full py-3 px-5 bg-transparent border-[1.5px] border-transparent focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 text-zinc-600 outline-none transition-all"
                                />
                              </td>
                              {allSubjects.map((subject, subIdx) => {
                                const gradeObj = student.subjects?.find(s => s.subjectName === subject);
                                return (
                                  <td key={subIdx} className="p-0">
                                    <div className="h-full w-full py-2 px-3">
                                      <input 
                                        value={gradeObj?.obtained || ''}
                                        onChange={(e) => handleSubjectChange(idx, subject, e.target.value)}
                                        placeholder="-"
                                        className="w-full min-w-[80px] py-1 px-2 rounded bg-zinc-100 text-zinc-900 border-[1.5px] border-transparent font-medium focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 outline-none transition-all text-center"
                                      />
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="p-0">
                                <input 
                                  value={student.totalMarksObtained || ''}
                                  onChange={(e) => handleCellChange(idx, 'totalMarksObtained', e.target.value)}
                                  placeholder="-"
                                  className="w-full h-full py-3 px-5 bg-transparent border-[1.5px] border-transparent font-medium text-zinc-900 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100"
                                />
                              </td>
                              <td className="p-0">
                                <div className="h-full w-full py-2 px-3">
                                  <input 
                                    value={student.percentage ? student.percentage.replace('%', '') : ''}
                                    onChange={(e) => handleCellChange(idx, 'percentage', e.target.value ? `${e.target.value}%` : '')}
                                    placeholder="-"
                                    className="w-full min-w-[60px] py-1 px-2 rounded bg-blue-50 text-blue-800 border-[1.5px] border-transparent font-medium focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 outline-none transition-all text-center"
                                  />
                                </div>
                              </td>
                              <td className="p-0">
                                <div className="h-full w-full py-2 px-3">
                                  <select 
                                    value={student.result || ''}
                                    onChange={(e) => handleCellChange(idx, 'result', e.target.value)}
                                    className={`w-full py-1 px-2 rounded border-[1.5px] border-transparent font-medium outline-none transition-all appearance-none cursor-pointer focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 ${
                                      student.result === 'Pass' ? 'text-green-800 bg-green-100' : 
                                      student.result === 'Fail' ? 'text-red-800 bg-red-100' : 
                                      'text-zinc-800 bg-zinc-100'
                                    }`}
                                  >
                                    <option value="">-</option>
                                    <option value="Pass">Pass</option>
                                    <option value="Fail">Fail</option>
                                    <option value="Promoted">Promoted</option>
                                  </select>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
      </main>
    </div>
  );
}

function preprocessImage(file: File, maxWidth = 1600, maxHeight = 1600, quality = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Failed to get canvas text"));
          return;
        }

        // Fill background with white in case of transparent PNG/WEBP
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Enhance contrast slightly using composite operation (optional, helpful for faded scans)
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to optimal JPEG to save tokens and speed up API
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}

