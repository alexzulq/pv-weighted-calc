import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";
import * as XLSX from 'xlsx';

declare var Chart: any;

// --- Types ---

interface RawDataPoint {
  timestamp: number;
  [key: string]: number;
}

interface ResampledPoint {
  timestamp: number;
  dateStr: string; // YYYY-MM-DD
  timeStr: string; // HH:mm
  weightedIrradiance: number; // Average of active irradiance sensors
  averageTemperature: number; // Average of active temperature sensors
  sensors: { [key: string]: number }; // Holds values for ALL sensors (Irr + Temp)
}

interface DailyStats {
  date: string;
  peakIrradiance: number;
  avgTemperature: number; // Overall Irradiance-Weighted Average (all temp sensors combined)
  tempSensors: { [key: string]: number }; // Weighted Average per specific sensor
  irrSensors: { [key: string]: number }; // Total Wh/m^2 per specific irradiance sensor
  totalIrradianceWh: number; // Wh/m^2 (Global Weighted Average)
}

interface Notification {
  type: 'info' | 'success' | 'error';
  message: string;
}

// --- Helper Functions ---

const parseCSV = async (file: File): Promise<RawDataPoint[]> => {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  
  if (lines.length < 2) return [];

  // 1. Detect Header Row (Scan first 20 lines)
  let headerRowIdx = -1;
  let headers: string[] = [];
  let delimiter = ',';

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('timestamp') || line.includes('date') || line.includes('time')) {
       headerRowIdx = i;
       delimiter = lines[i].includes(';') ? ';' : ',';
       headers = lines[i].split(delimiter).map(h => h.trim());
       break;
    }
  }

  if (headerRowIdx === -1) {
    // Fallback to first line
    headerRowIdx = 0;
    delimiter = lines[0].includes(';') ? ';' : ',';
    headers = lines[0].split(delimiter).map(h => h.trim());
  }
  
  // 2. Identify Timestamp Column
  let timestampIndex = headers.findIndex(h => {
    const lower = h.toLowerCase();
    return ['timestamp', 'date_time', 'datetime', 'date time'].includes(lower);
  });

  if (timestampIndex === -1) {
    timestampIndex = headers.findIndex(h => {
      const lower = h.toLowerCase();
      return (lower.includes('date') || lower.includes('time')) && 
             !lower.includes('temp') && !lower.includes('module');
    });
  }

  if (timestampIndex === -1) timestampIndex = 0;

  // 3. Detect Date Format (DD/MM vs MM/DD)
  // Scan a few rows to determine format
  let isDMY = false; // Default assumption could be MDY or we detect
  let maxFirstPart = 0;
  
  for (let i = headerRowIdx + 1; i < Math.min(lines.length, 50); i++) {
      const parts = lines[i].split(delimiter);
      if (parts.length <= timestampIndex) continue;
      const dateStr = parts[timestampIndex];
      // Regex for xx/xx/xxxx or xx-xx-xxxx
      const match = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (match) {
          const p1 = parseInt(match[1]);
          const p2 = parseInt(match[2]);
          if (p1 > 12) isDMY = true; // First part > 12 implies Day
          maxFirstPart = Math.max(maxFirstPart, p1);
      }
  }

  const data: RawDataPoint[] = [];

  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter);
    if (values.length <= timestampIndex) continue;

    const timeVal = values[timestampIndex];
    if (!timeVal) continue;
    
    let timestamp = NaN;

    // Custom Parsing
    // Check for DD/MM/YYYY HH:MM structure explicitly if we suspect non-US format
    const parts = timeVal.split(/[ T]/);
    const datePart = parts[0];
    const timePart = parts[1] || '00:00';
    
    // Check if d/m/y
    const dateComp = datePart.split(/[-/.]/);
    if (dateComp.length === 3) {
        let y = 0, m = 0, d = 0;
        // Case: YYYY-MM-DD
        if (dateComp[0].length === 4) {
            y = parseInt(dateComp[0]);
            m = parseInt(dateComp[1]) - 1;
            d = parseInt(dateComp[2]);
        } 
        // Case: DD/MM/YYYY (detected or guessed)
        else if (isDMY || parseInt(dateComp[0]) > 12) {
             d = parseInt(dateComp[0]);
             m = parseInt(dateComp[1]) - 1;
             y = parseInt(dateComp[2]);
        }
        // Case: MM/DD/YYYY (default fallback)
        else {
             m = parseInt(dateComp[0]) - 1;
             d = parseInt(dateComp[1]);
             y = parseInt(dateComp[2]);
        }

        const timeComp = timePart.split(':');
        const hr = parseInt(timeComp[0] || '0');
        const min = parseInt(timeComp[1] || '0');
        const sec = parseInt(timeComp[2] || '0');

        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            const dt = new Date(y, m, d, hr, min, sec);
            timestamp = dt.getTime();
        }
    }

    if (isNaN(timestamp)) {
        timestamp = Date.parse(timeVal);
    }

    if (!isNaN(timestamp)) {
      const point: RawDataPoint = { timestamp };
      headers.forEach((h, index) => {
        if (index !== timestampIndex && values[index]) {
          const valStr = values[index].replace(',', '.'); // Handle commas as decimals
          const val = parseFloat(valStr);
          if (!isNaN(val)) {
            point[h] = val; // CSV usually implies single file context, so simple header is fine
          }
        }
      });
      data.push(point);
    }
  }
  return data;
};

const parseExcel = async (file: File): Promise<RawDataPoint[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        
        const parsedData: RawDataPoint[] = [];
        const hasMultipleSheets = workbook.SheetNames.length > 1;

        workbook.SheetNames.forEach((sheetName: string) => {
            const worksheet = workbook.Sheets[sheetName];
            // Get raw rows to find header manually. `header: 1` returns array of arrays.
            const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
            
            if (rawRows.length === 0) return;

            // 1. Detect Header Row (Scan first 20 rows of EACH sheet)
            let headerRowIdx = -1;
            let headers: string[] = [];

            for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
                const row = rawRows[i];
                if (!row) continue;
                const rowStr = row.join(' ').toLowerCase();
                if (rowStr.includes('timestamp') || rowStr.includes('date') || rowStr.includes('time')) {
                    headerRowIdx = i;
                    headers = row.map((c: any) => String(c).trim());
                    break;
                }
            }

            if (headerRowIdx === -1) {
                // Fallback: Assume first row if no keyword found
                headerRowIdx = 0;
                if (rawRows[0]) headers = rawRows[0].map((c: any) => String(c).trim());
            }

            // 2. Identify Timestamp Column
            let timestampIndex = headers.findIndex(h => {
                const lower = h.toLowerCase();
                return ['timestamp', 'date_time', 'datetime', 'date time'].includes(lower);
            });

            if (timestampIndex === -1) {
                timestampIndex = headers.findIndex(h => {
                    const lower = h.toLowerCase();
                    return (lower.includes('date') || lower.includes('time')) && 
                           !lower.includes('temp') && !lower.includes('module');
                });
            }

            if (timestampIndex === -1) timestampIndex = 0;

            // 3. Process Data Rows for this sheet
            for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
                const row = rawRows[i];
                if (!row || row.length <= timestampIndex) continue;

                const timeVal = row[timestampIndex];
                let timestamp: number | null = null;

                if (timeVal instanceof Date) {
                    timestamp = timeVal.getTime();
                } else if (typeof timeVal === 'number') {
                     // Excel serialized date
                     timestamp = new Date((timeVal - (25567 + 2)) * 86400 * 1000).getTime();
                } else if (typeof timeVal === 'string') {
                    // Try standard parse first
                    timestamp = Date.parse(timeVal);
                }

                if (timestamp && !isNaN(timestamp)) {
                    const point: RawDataPoint = { timestamp };
                    headers.forEach((h, colIdx) => {
                        if (colIdx !== timestampIndex && row[colIdx] != null) {
                            const val = row[colIdx];
                            let numVal = NaN;
                            if (typeof val === 'number') {
                                numVal = val;
                            } else if (typeof val === 'string') {
                                numVal = parseFloat(val.replace(',', '.'));
                            }

                            if (!isNaN(numVal)) {
                                // Prevent key collision by prefixing Sheet Name if needed
                                const uniqueKey = hasMultipleSheets ? `${sheetName} - ${h}` : h;
                                point[uniqueKey] = numVal;
                            }
                        }
                    });
                    parsedData.push(point);
                }
            }
        });
        resolve(parsedData);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
};

const getPotentialIrradianceKeys = (keys: string[]): string[] => {
    return keys.filter(k => {
        const lower = k.toLowerCase();
        if (lower.includes('sts')) return true;
        if (lower.includes('irr')) return true;
        if (lower.includes('poa')) return true;
        if (lower.includes('ghi')) return true;
        if (lower.includes('solar')) return true;
        if (lower.includes('rad')) return true;
        if (lower.includes('w/m')) return true;
        if (lower.includes('val')) return true; 
        if (lower.includes('sensor')) return true;
        if (lower.includes('pyr')) return true;
        if (lower.includes('glob')) return true;
        // Avoid explicitly calculating Temps here, but generally 'temp' keys are excluded by these checks
        return false;
    });
};

// --- Mock Data Generator ---

const generateMockFiles = (): File[] => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const startDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); 

  let csvIrr = "Timestamp;STS02;STS04;STS05;STS06;STS09\n";
  let csvTempA = "date_time;Module Temp 01;Module Temp 02;Module Temp 03\n"; 
  let csvTempB = "Timestamp;Module Temp 04;Module Temp 05;Module Temp 06\n";

  const days = 3;
  const stepsPerDay = 24 * 12; // 5 min intervals

  for (let d = 0; d < days; d++) {
    for (let s = 0; s < stepsPerDay; s++) {
        const time = new Date(startDate.getTime() + (d * 24 * 60 * 60 * 1000) + (s * 5 * 60 * 1000));
        const hours = time.getHours() + time.getMinutes() / 60;
        
        let irradiance = 0;
        if (hours > 6 && hours < 18) {
            const peak = 1000 + (Math.random() - 0.5) * 50; 
            irradiance = peak * Math.sin(((hours - 6) / 12) * Math.PI);
        }
        if (Math.random() > 0.95 && irradiance > 100) irradiance *= 0.4;
        irradiance = Math.max(0, irradiance + (Math.random() - 0.5) * 20);

        const ambient = 20 + 5 * Math.sin(((hours - 4) / 24) * 2 * Math.PI);
        const baseTemp = ambient + (irradiance / 1000) * 25;
        
        const yyyy = time.getFullYear();
        const mm = String(time.getMonth() + 1).padStart(2, '0');
        const dd = String(time.getDate()).padStart(2, '0');
        const hh = String(time.getHours()).padStart(2, '0');
        const min = String(time.getMinutes()).padStart(2, '0');
        const timeStr = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
        
        const sts02 = Math.max(0, irradiance * 0.98 + (Math.random() - 0.5) * 5);
        const sts04 = Math.max(0, irradiance * 1.02 + (Math.random() - 0.5) * 5);
        const sts05 = Math.max(0, irradiance * 1.00 + (Math.random() - 0.5) * 5);
        const sts06 = Math.max(0, irradiance * 0.95 + (Math.random() - 0.5) * 5);
        const sts09 = Math.max(0, irradiance * 1.01 + (Math.random() - 0.5) * 5);

        csvIrr += `${timeStr};${sts02.toFixed(2)};${sts04.toFixed(2)};${sts05.toFixed(2)};${sts06.toFixed(2)};${sts09.toFixed(2)}\n`;
        
        const t1 = baseTemp + (Math.random() - 0.5) * 1;
        const t2 = baseTemp + (Math.random() - 0.5) * 1.2;
        const t3 = baseTemp + (Math.random() - 0.5) * 0.8;
        const t4 = baseTemp + 2 + (Math.random() - 0.5) * 1;
        const t5 = baseTemp + 2.5 + (Math.random() - 0.5) * 1;
        const t6 = baseTemp + 1.5 + (Math.random() - 0.5) * 1;

        csvTempA += `${timeStr};${t1.toFixed(2)};${t2.toFixed(2)};${t3.toFixed(2)}\n`;
        csvTempB += `${timeStr};${t4.toFixed(2)};${t5.toFixed(2)};${t6.toFixed(2)}\n`;
    }
  }

  return [
    new File([csvIrr], "POA_Data_Combined.csv", { type: "text/csv" }),
    new File([csvTempA], "Module_Temp_Group_1.csv", { type: "text/csv" }),
    new File([csvTempB], "Module_Temp_Group_2.csv", { type: "text/csv" })
  ];
};


// --- Main Component ---

const App = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [processedData, setProcessedData] = useState<ResampledPoint[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [tempSensorNames, setTempSensorNames] = useState<string[]>([]);
  const [irrSensorNames, setIrrSensorNames] = useState<string[]>([]);
  const [showFileList, setShowFileList] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string>('');
  const [analyzing, setAnalyzing] = useState(false);
  const [inputType, setInputType] = useState<'power' | 'energy'>('energy');

  // Refs for Charts
  const irrChartRef = useRef<HTMLCanvasElement>(null);
  const tempChartRef = useRef<HTMLCanvasElement>(null);
  const scatterChartRef = useRef<HTMLCanvasElement>(null);
  const irrChartInstance = useRef<any>(null);
  const tempChartInstance = useRef<any>(null);
  const scatterChartInstance = useRef<any>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...newFiles]);
      setNotification({ type: 'info', message: `Added ${newFiles.length} file(s).` });
      setShowFileList(true);
    }
    e.target.value = ''; 
  };

  const removeFile = (indexToRemove: number) => {
    setFiles(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const clearAllFiles = () => {
    setFiles([]);
    setProcessedData([]);
    setDailyStats([]);
    setTempSensorNames([]);
    setIrrSensorNames([]);
    setNotification(null);
  };

  const handleLoadMockData = () => {
    const mocks = generateMockFiles();
    setFiles(mocks);
    setShowFileList(true);
    setInputType('power'); // Mock data is in W/m2
    setNotification({ type: 'info', message: 'Loaded mock data samples. Processing...' });
    setTimeout(() => processData(mocks, 'power'), 500); 
  };

  const handleDownloadMockData = () => {
    const mocks = generateMockFiles();
    mocks.forEach(file => {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    setNotification({ type: 'success', message: 'Mock CSV files downloaded.' });
  };

  const handleExportExcel = () => {
    if (dailyStats.length === 0) return;
    try {
      const exportData = dailyStats.map(stat => {
        const row: any = {
          "Date": stat.date,
          "Array Avg Temp (°C)": parseFloat(stat.avgTemperature.toFixed(2)),
          "Total Energy (Wh/m²)": parseFloat(stat.totalIrradianceWh.toFixed(2))
        };
        tempSensorNames.forEach(name => {
             row[name + " (°C)"] = parseFloat(stat.tempSensors[name]?.toFixed(2) || "0");
        });
        irrSensorNames.forEach(name => {
             row[name + " (Wh/m²)"] = parseFloat(stat.irrSensors[name]?.toFixed(2) || "0");
        });
        return row;
      });

      const ws = XLSX.utils.json_to_sheet(exportData);
      const wscols = [
        { wch: 12 }, { wch: 22 }, { wch: 20 },
        ...tempSensorNames.map(() => ({ wch: 20 })),
        ...irrSensorNames.map(() => ({ wch: 20 }))
      ];
      ws['!cols'] = wscols;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Daily Summary");
      XLSX.writeFile(wb, "PV_Production_Summary.xlsx");
      setNotification({ type: 'success', message: 'Daily summary exported to Excel.' });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Failed to export Excel file.' });
    }
  };

  const processData = async (filesOverride?: File[], typeOverride?: 'power' | 'energy') => {
    const targetFiles = filesOverride || files;
    const currentInputType = typeOverride || inputType;

    if (targetFiles.length === 0) {
      setNotification({ type: 'error', message: "No files selected." });
      return;
    }
    
    setLoading(true);
    if (!filesOverride) setNotification({ type: 'info', message: `Processing ${targetFiles.length} files as ${currentInputType === 'energy' ? 'Irradiation (Wh/m²)' : 'Irradiance (W/m²)'}...` });
    setAiAnalysis('');

    try {
      let allRawPoints: RawDataPoint[] = [];
      const isMultiFile = targetFiles.length > 1;

      for (const file of targetFiles) {
        let points: RawDataPoint[] = [];
        if (file.name.toLowerCase().endsWith('.csv')) {
             points = await parseCSV(file);
        } else if (file.name.match(/\.xlsx?$/i)) {
             points = await parseExcel(file);
        }

        // If Multi-file, prefix keys first so we can identify them uniquely
        if (isMultiFile) {
            const fileNameNoExt = file.name.replace(/\.[^/.]+$/, "");
            points = points.map(p => {
                const newP: RawDataPoint = { timestamp: p.timestamp };
                Object.keys(p).forEach(k => {
                    if (k !== 'timestamp') {
                        newP[`${fileNameNoExt} - ${k}`] = p[k];
                    }
                });
                return newP;
            });
        }

        // --- CONVERSION LOGIC: Energy -> Power ---
        // Runs per file to calculate delta-time correctly
        if (currentInputType === 'energy' && points.length > 0) {
            // Sort by time to calculate diff
            points.sort((a, b) => a.timestamp - b.timestamp);
            
            // Identify which keys in *this* file are irradiance
            const sampleKeys = Object.keys(points[0]).filter(k => k !== 'timestamp');
            const fileIrrKeys = getPotentialIrradianceKeys(sampleKeys);

            if (fileIrrKeys.length > 0) {
                console.log(`Converting keys for ${file.name}:`, fileIrrKeys);
                for (let i = 0; i < points.length; i++) {
                    let durationHrs = (5 / 60); // Default fallback (5 mins)
                    
                    if (i > 0) {
                        const diffMs = points[i].timestamp - points[i - 1].timestamp;
                        // Filter out massive gaps (e.g. overnight or data outage > 12h) to avoid dividing by huge numbers
                        if (diffMs > 0 && diffMs < 12 * 60 * 60 * 1000) {
                            durationHrs = diffMs / (1000 * 3600);
                        }
                    } else if (points.length > 1) {
                        const diffMs = points[1].timestamp - points[0].timestamp;
                         if (diffMs > 0 && diffMs < 12 * 60 * 60 * 1000) {
                             durationHrs = diffMs / (1000 * 3600);
                         }
                    }

                    fileIrrKeys.forEach(key => {
                        const val = points[i][key];
                        if (val !== undefined && val !== null && durationHrs > 0) {
                             // Convert Wh/m2 (or kJ/m2) -> W/m2
                             // Result = Energy / Time(h)
                             points[i][key] = val / durationHrs;
                        }
                    });
                }
            }
        }

        allRawPoints = allRawPoints.concat(points);
      }

      if (allRawPoints.length === 0) throw new Error("No valid data points found.");

      const allKeys = new Set<string>();
      allRawPoints.forEach(p => Object.keys(p).forEach(k => {
          if (k !== 'timestamp') allKeys.add(k);
      }));
      const allKeyArray = Array.from(allKeys);

      const detectedTempKeys = allKeyArray.filter(k => {
        const lower = k.toLowerCase();
        return (lower.includes('temp') || lower.includes('module') || lower.includes('°') || lower.includes('deg')) && 
               !lower.includes('irr') && !lower.includes('solar') && !lower.includes('poa');
      });

      // Use the generic helper, but filter out temp keys just in case
      let irradianceKeys = getPotentialIrradianceKeys(allKeyArray).filter(k => !detectedTempKeys.includes(k));

      if (irradianceKeys.length === 0) {
          const remainingKeys = allKeyArray.filter(k => !detectedTempKeys.includes(k));
          if (remainingKeys.length > 0) irradianceKeys = remainingKeys;
      }

      setTempSensorNames(detectedTempKeys.sort());
      setIrrSensorNames(irradianceKeys.sort());

      if (irradianceKeys.length === 0) throw new Error("Could not detect any Irradiance columns.");

      // --- UNIT NORMALIZATION ---
      // Some sensors might be in kW/m^2 (0-1.2), others in W/m^2 (0-1200).
      // If we converted Energy -> Power, we might have converted 0.05 kWh -> 0.6 kW. 
      // This step will catch that 0.6 and convert it to 600 W.
      irradianceKeys.forEach(key => {
         let maxVal = 0;
         allRawPoints.forEach(p => {
             if (p[key] > maxVal) maxVal = p[key];
         });
         
         // If peak is < 10 (reasonable cutoff, since sun is ~1000W), assume kW.
         if (maxVal > 0 && maxVal < 10) {
             console.log(`Auto-detect: Normalizing ${key} from kW/m² to W/m² (max: ${maxVal})`);
             allRawPoints.forEach(p => {
                 if (p[key] !== undefined) {
                     p[key] = p[key] * 1000;
                 }
             });
         }
      });
      // --------------------------

      const intervalMs = 5 * 60 * 1000;
      const buckets = new Map<number, { count: number; sums: { [key: string]: number }; counts: { [key: string]: number } }>();

      allRawPoints.forEach(p => {
        // Quantize to 5 minutes
        const bucketTime = Math.floor(p.timestamp / intervalMs) * intervalMs;
        if (!buckets.has(bucketTime)) buckets.set(bucketTime, { count: 0, sums: {}, counts: {} });
        const bucket = buckets.get(bucketTime)!;
        bucket.count++;

        Object.keys(p).forEach(key => {
          if (key === 'timestamp') return;
          let val = p[key];
          
          // --- FILTER: Remove unreasonable temp data > 200°C ---
          if (detectedTempKeys.includes(key) && val > 200) {
              return; 
          }
          
          // --- FILTER: Negative irradiance clipped to 0 ---
          if (irradianceKeys.includes(key) && val < 0) {
              val = 0;
          }

          bucket.sums[key] = (bucket.sums[key] || 0) + val;
          bucket.counts[key] = (bucket.counts[key] || 0) + 1;
        });
      });

      const resampled: ResampledPoint[] = [];
      Array.from(buckets.keys()).sort().forEach(time => {
        const bucket = buckets.get(time)!;
        const date = new Date(time);
        const sensorValues: { [key: string]: number } = {};

        // Use Date components for stable date string (avoiding some TZ jumps)
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        
        // This DateStr should be used for grouping
        const dateStr = `${yyyy}-${mm}-${dd}`;
        const timeStr = `${hh}:${min}`;

        let totalIrrSum = 0;
        let activeIrrCount = 0;
        irradianceKeys.forEach(key => {
           if (bucket.counts[key] && bucket.counts[key] > 0) {
               const val = bucket.sums[key] / bucket.counts[key];
               sensorValues[key] = val;
               totalIrrSum += val;
               activeIrrCount++;
           }
        });
        const finalIrradiance = activeIrrCount > 0 ? totalIrrSum / activeIrrCount : 0;

        let totalTempSum = 0;
        let activeTempCount = 0;
        detectedTempKeys.forEach(key => {
            if (bucket.counts[key] && bucket.counts[key] > 0) {
                const val = bucket.sums[key] / bucket.counts[key];
                sensorValues[key] = val;
                totalTempSum += val;
                activeTempCount++;
            } else {
                // Do not fill missing temp with 0, as it drags down average? 
                // However, charts need something. We will use 0 for chart safety but keep stats logic separate.
                sensorValues[key] = 0;
            }
        });
        const avgTemp = activeTempCount > 0 ? totalTempSum / activeTempCount : 0;

        // Push if we have valid data (either sun is up OR we have temp data)
        if (finalIrradiance > 0 || activeTempCount > 0) {
           resampled.push({
             timestamp: time,
             dateStr: dateStr,
             timeStr: timeStr,
             weightedIrradiance: finalIrradiance,
             averageTemperature: avgTemp,
             sensors: sensorValues
           });
        }
      });

      setProcessedData(resampled);

      const statsMap = new Map<string, any>();
      resampled.forEach(p => {
        if (!statsMap.has(p.dateStr)) {
          statsMap.set(p.dateStr, { maxIrr: 0, sumIrr: 0, weightedTempSum: 0, sumIrrForTemp: 0, sensorWeightedSum: {}, sensorSumIrr: {}, irrSensorSums: {} });
        }
        const s = statsMap.get(p.dateStr)!;
        s.maxIrr = Math.max(s.maxIrr, p.weightedIrradiance);
        
        // Accumulate Irradiance (Wh) - discrete integral (sum of rates)
        s.sumIrr += p.weightedIrradiance;
        
        // Accumulate Weighted Temp
        // Only if we have temperature data for this interval
        if (p.averageTemperature > 0) {
          s.weightedTempSum += p.averageTemperature * p.weightedIrradiance;
          s.sumIrrForTemp += p.weightedIrradiance;
        }

        detectedTempKeys.forEach(key => {
            const val = p.sensors[key];
            if (val && val !== 0) {
                s.sensorWeightedSum[key] = (s.sensorWeightedSum[key] || 0) + val * p.weightedIrradiance;
                s.sensorSumIrr[key] = (s.sensorSumIrr[key] || 0) + p.weightedIrradiance;
            }
        });

        // Accumulate individual irradiance sensor sums for daily total
        irradianceKeys.forEach(key => {
            const val = p.sensors[key];
            if (val !== undefined && val !== null) {
                s.irrSensorSums[key] = (s.irrSensorSums[key] || 0) + val;
            }
        });
      });

      const stats: DailyStats[] = [];
      statsMap.forEach((val, date) => {
        // Assuming 5 minute intervals (5/60 hours)
        const totalWh = val.sumIrr * (5 / 60);
        
        // Weighted Average = Sum(Temp * Irr) / Sum(Irr)
        // If sumIrrForTemp is 0 (all night or cloudy?), avg is 0.
        const overallAvgTemp = val.sumIrrForTemp > 0 ? val.weightedTempSum / val.sumIrrForTemp : 0;
        
        const individualTemps: { [key: string]: number } = {};
        detectedTempKeys.forEach(key => {
            const sumW = val.sensorWeightedSum[key] || 0;
            const sumI = val.sensorSumIrr[key] || 0;
            individualTemps[key] = sumI > 0 ? sumW / sumI : 0;
        });

        const individualIrr: { [key: string]: number } = {};
        irradianceKeys.forEach(key => {
            const sum = val.irrSensorSums[key] || 0;
            individualIrr[key] = sum * (5/60);
        });

        stats.push({
          date,
          peakIrradiance: val.maxIrr,
          avgTemperature: overallAvgTemp,
          tempSensors: individualTemps,
          irrSensors: individualIrr,
          totalIrradianceWh: totalWh
        });
      });
      
      setDailyStats(stats.sort((a,b) => a.date.localeCompare(b.date)));
      setNotification({ type: 'success', message: `Processed ${resampled.length} intervals. Found ${irradianceKeys.length} Irr sensors.` });

    } catch (err: any) {
      console.error(err);
      setNotification({ type: 'error', message: err.message || "Error processing files." });
    } finally {
      setLoading(false);
    }
  };

  // --- Effects for Charts ---
  useEffect(() => {
    if (processedData.length === 0) return;
    if (irrChartInstance.current) irrChartInstance.current.destroy();
    if (tempChartInstance.current) tempChartInstance.current.destroy();
    if (scatterChartInstance.current) scatterChartInstance.current.destroy();

    const colors = ['#ef4444', '#f97316', '#f43f5e', '#ec4899', '#d946ef', '#8b5cf6', '#6366f1'];
    // Palette for irradiance (Warm tones)
    const irrColors = ['#eab308', '#f59e0b', '#d97706', '#b45309', '#fcd34d', '#fbbf24', '#f87171'];

    // 1. Irradiance Chart (Multi-Sensor)
    if (irrChartRef.current) {
      const ctx = irrChartRef.current.getContext('2d');
      const irrDatasets = irrSensorNames.map((name, idx) => {
         const color = irrColors[idx % irrColors.length];
         return {
            label: name,
            data: processedData.map(d => d.sensors[name] ?? null),
            borderColor: color,
            backgroundColor: color,
            fill: false,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.1
         };
      });

      if (ctx) {
         irrChartInstance.current = new Chart(ctx, {
            type: 'line',
            data: {
               labels: processedData.map(d => `${d.dateStr} ${d.timeStr}`),
               datasets: irrDatasets
            },
            options: {
               responsive: true,
               maintainAspectRatio: false,
               interaction: { mode: 'index', intersect: false },
               scales: {
                  y: { beginAtZero: true, title: { display: true, text: 'Irradiance (W/m²)' } },
                  x: { ticks: { maxTicksLimit: 12 } }
               },
               plugins: { legend: { position: 'top', align: 'end' } }
            }
         });
      }
    }

    // 2. Temperature Chart
    if (tempChartRef.current) {
       const ctx = tempChartRef.current.getContext('2d');
       const tempDatasets = tempSensorNames.map((name, idx) => {
          const color = colors[idx % colors.length];
          return {
            label: name,
            data: processedData.map(d => d.sensors[name] === 0 ? null : d.sensors[name]),
            borderColor: color,
            backgroundColor: color,
            pointRadius: 0,
            borderWidth: 1.5,
            tension: 0.1,
            spanGaps: false
          };
       });

       if (ctx) {
          tempChartInstance.current = new Chart(ctx, {
             type: 'line',
             data: {
                labels: processedData.map(d => `${d.dateStr} ${d.timeStr}`),
                datasets: tempDatasets
             },
             options: {
               responsive: true,
               maintainAspectRatio: false,
               interaction: { mode: 'index', intersect: false },
               scales: {
                  y: { title: { display: true, text: 'Temperature (°C)' } },
                  x: { ticks: { maxTicksLimit: 12 } }
               },
               plugins: { legend: { position: 'top', align: 'end' } }
             }
          });
       }
    }

    // 3. Scatter Chart
    if (scatterChartRef.current) {
      const ctx = scatterChartRef.current.getContext('2d');
      if (ctx) {
        scatterChartInstance.current = new Chart(ctx, {
          type: 'scatter',
          data: {
            datasets: [{
              label: 'Avg Temp vs Irradiance',
              data: processedData.filter(d => d.averageTemperature !== 0).map(d => ({
                  x: d.weightedIrradiance,
                  y: d.averageTemperature
                })),
              backgroundColor: 'rgba(59, 130, 246, 0.5)',
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { type: 'linear', position: 'bottom', title: { display: true, text: 'Irradiance (W/m²)' } },
              y: { title: { display: true, text: 'Avg Temperature (°C)' } }
            },
            plugins: {
              tooltip: { callbacks: { label: (ctx: any) => `Irr: ${ctx.raw.x.toFixed(1)}, Temp: ${ctx.raw.y.toFixed(1)}` } }
            }
          }
        });
      }
    }
    
    return () => {
      if (irrChartInstance.current) irrChartInstance.current.destroy();
      if (tempChartInstance.current) tempChartInstance.current.destroy();
      if (scatterChartInstance.current) scatterChartInstance.current.destroy();
    };
  }, [processedData, tempSensorNames, irrSensorNames]);

  const generateAIInsights = async () => {
    if (dailyStats.length === 0) return;
    setAnalyzing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const simpleStats = dailyStats.slice(0, 7).map(s => ({
          date: s.date,
          avgTemp: s.avgTemperature.toFixed(1),
          totalEnergy: s.totalIrradianceWh.toFixed(0)
      }));
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Analyze the following solar PV daily production summary. 
        Look for efficiency trends, anomalies between temperature and production, or interesting weather patterns.
        Data: ${JSON.stringify(simpleStats, null, 2)}`
      });
      setAiAnalysis(response.text || 'No analysis returned.');
    } catch (e) {
      console.error(e);
      setAiAnalysis('Failed to generate analysis.');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen p-6 max-w-[1600px] mx-auto">
      <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 tracking-tight">PV Performance Dashboard</h1>
          <p className="text-gray-500 mt-1">Multi-sensor temperature analysis & irradiance weighting</p>
        </div>
        
        <div className="flex flex-col md:flex-row gap-3 items-end md:items-center">
             <div className="flex items-center gap-2 mr-4 bg-white px-3 py-2 rounded-lg border border-gray-200 shadow-sm">
                <span className="text-sm font-medium text-gray-700">Input Data:</span>
                <div className="flex bg-gray-100 p-1 rounded-md">
                    <button 
                        onClick={() => setInputType('power')}
                        className={`px-2 py-1 text-xs font-medium rounded transition-colors ${inputType === 'power' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                        W/m² (Power)
                    </button>
                    <button 
                         onClick={() => setInputType('energy')}
                         className={`px-2 py-1 text-xs font-medium rounded transition-colors ${inputType === 'energy' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                        Wh/m² (Energy)
                    </button>
                </div>
            </div>

            <div className="flex gap-2 mr-2">
                <button onClick={handleLoadMockData} className="px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-sm font-medium transition-colors">Load Mock Data</button>
                 <button onClick={handleDownloadMockData} className="px-3 py-2 text-indigo-600 hover:text-indigo-800 text-sm font-medium underline">Download Samples</button>
            </div>
            <div className="h-6 w-px bg-gray-300 hidden md:block"></div>
            <div className="flex gap-3">
              <input type="file" accept=".csv, .xlsx, .xls" multiple onChange={handleFileUpload} className="hidden" id="file-upload"/>
              <label htmlFor="file-upload" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow cursor-pointer font-medium transition-colors flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                {files.length > 0 ? `${files.length} Files` : 'Upload Files'}
              </label>
              <button onClick={() => processData()} disabled={files.length === 0 || loading} className={`px-4 py-2 rounded-lg font-medium shadow transition-colors ${files.length === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : loading ? 'bg-yellow-500 text-white cursor-wait' : 'bg-green-600 hover:bg-green-700 text-white'}`}>
                {loading ? 'Processing...' : 'Process Data'}
              </button>
            </div>
        </div>
      </header>

      {notification && (
        <div className={`mb-6 p-4 rounded-lg border flex items-center gap-3 shadow-sm ${notification.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' : notification.type === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}>
          <span className="text-sm font-medium">{notification.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        <div className="xl:col-span-1 space-y-6">
          {files.length > 0 && (
             <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center cursor-pointer select-none" onClick={() => setShowFileList(!showFileList)}>
                    <h3 className="font-semibold text-gray-700">Selected Files ({files.length})</h3>
                    <svg className={`w-5 h-5 text-gray-400 transition-transform ${showFileList ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
                {showFileList && (
                    <div className="max-h-64 overflow-y-auto custom-scrollbar">
                        <ul className="divide-y divide-gray-100">
                            {files.map((file, idx) => (
                                <li key={idx} className="p-3 flex justify-between items-center hover:bg-gray-50 text-sm group">
                                    <span className="truncate text-gray-600 max-w-[200px]" title={file.name}>{file.name}</span>
                                    <button onClick={(e) => { e.stopPropagation(); removeFile(idx); }} className="text-gray-400 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity">Remove</button>
                                </li>
                            ))}
                        </ul>
                        <div className="p-3 bg-gray-50 border-t border-gray-100"><button onClick={clearAllFiles} className="w-full text-xs text-red-600 hover:text-red-800 font-medium py-1">Clear All Files</button></div>
                    </div>
                )}
             </div>
          )}

          {dailyStats.length > 0 && (
            <div className="bg-gradient-to-br from-indigo-50 to-white rounded-xl shadow-sm border border-indigo-100 p-5">
               <div className="flex items-center justify-between mb-3">
                 <h2 className="text-lg font-semibold text-indigo-900">AI Analysis</h2>
                 <button onClick={generateAIInsights} disabled={analyzing} className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700 disabled:opacity-50">{analyzing ? 'Thinking...' : 'Generate Report'}</button>
               </div>
               {aiAnalysis ? <div className="prose prose-sm prose-indigo text-gray-700 text-sm max-h-64 overflow-y-auto custom-scrollbar">{aiAnalysis}</div> : <p className="text-sm text-gray-400 italic">Click to generate insights.</p>}
            </div>
          )}

           {dailyStats.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">Overall Stats</h2>
              <div className="grid grid-cols-2 gap-4">
                 <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-xs text-gray-500 uppercase">Max Irradiance</p>
                    <p className="text-xl font-bold text-gray-800">{Math.max(...dailyStats.map(s => s.peakIrradiance)).toFixed(0)} <span className="text-xs font-normal text-gray-500">W/m²</span></p>
                 </div>
                 <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-xs text-gray-500 uppercase">Array Avg Temp</p>
                    <p className="text-xl font-bold text-gray-800">{(dailyStats.reduce((a, b) => a + b.avgTemperature, 0) / dailyStats.length).toFixed(1)} <span className="text-xs font-normal text-gray-500">°C</span></p>
                 </div>
              </div>
            </div>
          )}
        </div>

        <div className="xl:col-span-3 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 flex flex-col gap-6">
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 h-[300px]">
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">Irradiance Profile</h3>
                    {processedData.length > 0 ? <div className="relative w-full h-full pb-6"><canvas ref={irrChartRef}></canvas></div> : <div className="h-full flex items-center justify-center text-gray-400">Awaiting Data...</div>}
                </div>
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 h-[300px]">
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">Module Temperatures</h3>
                    {processedData.length > 0 ? <div className="relative w-full h-full pb-6"><canvas ref={tempChartRef}></canvas></div> : <div className="h-full flex items-center justify-center text-gray-400">Awaiting Data...</div>}
                </div>
            </div>
            <div className="lg:col-span-1 bg-white rounded-xl shadow-sm border border-gray-200 p-4 h-[400px] lg:h-auto">
              <div className="flex flex-col h-full">
                  <h3 className="text-sm font-semibold text-gray-600 mb-2">Correlation (Avg Temp vs Irr)</h3>
                  {processedData.length > 0 ? <div className="flex-1 relative w-full min-h-[300px]"><canvas ref={scatterChartRef}></canvas></div> : <div className="h-full flex items-center justify-center text-gray-400">Awaiting Data...</div>}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h3 className="font-semibold text-gray-800">Daily Production Summary</h3>
              <button onClick={handleExportExcel} disabled={dailyStats.length === 0} className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${dailyStats.length === 0 ? 'text-gray-400 bg-gray-100 cursor-not-allowed' : 'text-green-700 bg-green-50 hover:bg-green-100 border border-green-200'}`}>Export Excel</button>
            </div>
            <div className="overflow-x-auto custom-scrollbar pb-2">
              <table className="w-full text-sm text-left text-gray-600">
                <thead className="text-xs text-gray-700 uppercase bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 whitespace-nowrap">Date</th>
                    <th className="px-6 py-3 whitespace-nowrap">Array Avg Temp (°C)</th>
                    {tempSensorNames.map(name => <th key={name} className="px-6 py-3 whitespace-nowrap text-blue-600">{name} (°C)</th>)}
                    <th className="px-6 py-3 whitespace-nowrap">Total Energy (Wh/m²)</th>
                    {irrSensorNames.map(name => <th key={name} className="px-6 py-3 whitespace-nowrap text-amber-600">{name} (Wh/m²)</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {dailyStats.length > 0 ? dailyStats.map((stat, idx) => (
                    <tr key={idx} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-medium text-gray-900 whitespace-nowrap">{stat.date}</td>
                      <td className="px-6 py-3 whitespace-nowrap font-medium">{stat.avgTemperature.toFixed(1)}</td>
                      {tempSensorNames.map(name => <td key={name} className="px-6 py-3 whitespace-nowrap text-gray-500">{stat.tempSensors[name] !== undefined ? stat.tempSensors[name].toFixed(1) : '-'}</td>)}
                      <td className="px-6 py-3 whitespace-nowrap font-semibold text-gray-800">{stat.totalIrradianceWh.toFixed(1)}</td>
                      {irrSensorNames.map(name => <td key={name} className="px-6 py-3 whitespace-nowrap text-gray-500">{stat.irrSensors[name] !== undefined ? stat.irrSensors[name].toFixed(1) : '-'}</td>)}
                    </tr>
                  )) : (
                    <tr><td colSpan={4 + tempSensorNames.length + irrSensorNames.length} className="px-6 py-8 text-center text-gray-400">Upload files and process to see daily statistics.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);