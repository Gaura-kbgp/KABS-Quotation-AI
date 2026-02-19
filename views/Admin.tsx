import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Plus, Upload, FileSpreadsheet, FileText, AlertTriangle, CheckCircle, RefreshCw, X, Loader2, Database, Image as ImageIcon, Settings2, Sparkles, ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '../components/Button';
import { Manufacturer, ManufacturerFile, NKBARules, PricingTier, ManufacturerOption, CabinetSeries, WorkbookSection } from '../types';
import { storage } from '../services/storage';
import { determineExcelStructure, extractManufacturerSpecs } from '../services/ai';
import { normalizeNKBACode } from '../services/pricingEngine';
import type JSZip from 'jszip';

// --- HELPERS ---

const guessSection = (sheetName: string): WorkbookSection => {
    const s = sheetName.toLowerCase();
    if (s.includes('series') || s.includes('line')) return 'B-Series';
    if (s.includes('printed') || (s.includes('options') && s.includes('end'))) return 'M-PrintedEnds';
    if (s.includes('door') || s.includes('style')) return 'C-Door';
    if (s.includes('finish') || s.includes('paint') || s.includes('stain') || s.includes('wood') || s.includes('specie')) return 'D-Finish';
    if (s.includes('drawer') || s.includes('box') || s.includes('front')) return 'E-Drawer';
    if (s.includes('hinge') || s.includes('hardware') || s.includes('close')) return 'F-Hinge';
    if (s.includes('construction') || s.includes('panel') || s.includes('end') || s.includes('upgrade')) return 'G-Construction';
    if (s.includes('wall') && s.includes('price')) return 'H-WallPrice';
    if (s.includes('wall')) return 'H-WallPrice';
    if (s.includes('base') && s.includes('price')) return 'I-BasePrice';
    if (s.includes('base')) return 'I-BasePrice';
    if (s.includes('tall') || s.includes('pantry') || s.includes('utility')) return 'J-TallPrice';
    if (s.includes('accessory') || s.includes('filler') || s.includes('toe') || s.includes('molding')) return 'K-Accessory';
    if (s.includes('summary') || s.includes('total') || s.includes('note')) return 'L-Summary';
    if (s.includes('project') || s.includes('area') || s.includes('info')) return 'A-Context';
    return 'Unknown';
};

const mapSectionToCategory = (sec: WorkbookSection): ManufacturerOption['category'] => {
    switch (sec) {
        case 'B-Series': return 'Series';
        case 'C-Door': return 'Door';
        case 'D-Finish': return 'Finish';
        case 'E-Drawer': return 'Drawer';
        case 'F-Hinge': return 'Hinge';
        case 'G-Construction': return 'Construction';
        case 'M-PrintedEnds': return 'PrintedEnd';
        default: return 'Other';
    }
};

// Replaced by normalizeNKBACode from pricingEngine to ensure consistency
const normalizeImportSku = (val: any): string => {
    return normalizeNKBACode(String(val));
};

const findBestSkuInRow = (row: any[], primaryIndex: number | null): string | null => {
   // Relaxed Regex: Allows "B15", "12345", "VDB-24", "ABC"
   // Must start with alphanumeric, can contain dots/dashes
   const skuRegex = /^[A-Z0-9][A-Z0-9\-\.]*$/;
   
   if (primaryIndex !== null && row[primaryIndex]) {
       const val = normalizeImportSku(row[primaryIndex]);
       if (skuRegex.test(val) && val.length >= 2 && val.length < 20) return val;
   }

   for (let i = 0; i < Math.min(row.length, 12); i++) {
       if (!row[i]) continue;
       const val = normalizeImportSku(row[i]);
       if (val.length < 2 || val.length > 25) continue;
       
       // Filter out common headers/metadata
       if (val.match(/^(PAGE|ITEM|QTY|NOTE|DESC|PRICE|WIDTH|HEIGHT|DEPTH|SKU|CODE|TOTAL|SUBTOTAL)$/)) continue;
       
       // Heuristic: A real SKU usually has numbers, but some accessories (like "VALANCE") might not.
       // However, to be safe, we prefer mixed or numeric, but allow pure alpha if short-ish (e.g. "TK8" is mixed, "TOEKICK" is alpha).
       // Let's stick to the regex but exclude obvious sentences.
       
       if (skuRegex.test(val)) return val;
   }
   return null;
}

// Helper to parse price value and type from a cell
const parseOptionPrice = (cellValue: any, headerValue: string = ''): { price: number, pricingType: 'fixed' | 'percentage' | 'included' } => {
    if (!cellValue) return { price: 0, pricingType: 'included' };
    
    let strVal = String(cellValue).trim();
    if (strVal === '-' || strVal === '' || strVal.toLowerCase().includes('n/c') || strVal.toLowerCase().includes('no charge')) return { price: 0, pricingType: 'included' };
    
    const isPercent = strVal.includes('%') || headerValue.includes('%') || headerValue.includes('PCT');
    // Handle "+$150" or "15%"
    let val = parseFloat(strVal.replace(/[^0-9.-]/g, ''));
    
    if (isNaN(val) || val === 0) return { price: 0, pricingType: 'included' };
    
    if (isPercent) {
        // e.g. "15%" -> 15 -> 0.15
        if (val > 1) val = val / 100; 
        return { price: val, pricingType: 'percentage' };
    }
    
    // Heuristic: If val is small (< 1.0) it's likely a percentage (e.g. 0.15)
    if (val < 1.0 && val > -1.0) {
        return { price: val, pricingType: 'percentage' };
    }
    
    return { price: val, pricingType: 'fixed' };
}

// Helper to detect if a cell value looks like a price
const isPriceCell = (val: any): boolean => {
    const s = String(val).trim();
    if (!s || s === '-') return false;
    if (s.includes('$') || s.includes('%')) return true;
    const n = parseFloat(s);
    return !isNaN(n) && isFinite(n);
};

// --- MAIN COMPONENT ---

export const Admin: React.FC = () => {
  const navigate = useNavigate();
  
  // Data State - Initialize from LocalStorage for IMMEDIATE render
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>(() => {
      try {
          const local = localStorage.getItem('kabs_local_manufacturers');
          return local ? JSON.parse(local) : [];
      } catch (e) { return []; }
  });

  const [nkbaRules, setNkbaRules] = useState<NKBARules | null>(() => {
      try {
          const local = localStorage.getItem('kabs_local_nkba_rules');
          return local ? JSON.parse(local) : null;
      } catch (e) { return null; }
  });
  
  // UI State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newMfgName, setNewMfgName] = useState('');
  const [newDealerName, setNewDealerName] = useState(''); // NEW: Dealer Name Input
  const [managingMfg, setManagingMfg] = useState<Manufacturer | null>(null);
  const [activeCatalog, setActiveCatalog] = useState<Record<string, any>>({});
  
  // Loading States
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null); // For Deleting Manufacturer
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null); // For Deleting specific file
  
  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pricingInputRef = useRef<HTMLInputElement>(null);
  const specInputRef = useRef<HTMLInputElement>(null);

  // --- INITIAL LOAD & SYNC ---
  useEffect(() => {
    const loadData = async () => {
        const isAdmin = sessionStorage.getItem('kabs_is_admin');
        if (!isAdmin) {
            navigate('/login');
            return;
        }
        
        // Connection Check
        const { error: healthCheck } = await storage.checkConnection();
        if (healthCheck) {
            console.error("Supabase Connection Failed:", healthCheck);
            alert(`Database Connection Failed! \n\nPlease check your .env file.\nError: ${healthCheck.message}\nHint: Ensure VITE_SUPABASE_URL matches the project ID in your VITE_SUPABASE_ANON_KEY.`);
        }

        // Data is already initially populated from localStorage in useState logic above.
        // We now fetch fresh data to sync.
        try {
            const [mfgList, rules] = await Promise.all([
                storage.getManufacturers(),
                storage.getNKBARules()
            ]);
            // Update state (and re-render) only if we got data
            if (mfgList) setManufacturers(mfgList);
            if (rules) setNkbaRules(rules);
        } catch (e) {
            console.error("Failed to sync admin data", e);
        }
    };
    loadData();
  }, [navigate]);

  // --- CATALOG FETCHING ---
  useEffect(() => {
      const fetchCat = async () => {
          if (managingMfg) {
              // Optimization: Don't fetch if we know it's empty to avoid 404/400 errors
              if ((managingMfg.skuCount || 0) === 0) {
                  setActiveCatalog({});
                  return;
              }
              const cat = await storage.getManufacturerCatalog(managingMfg.id);
              setActiveCatalog(cat || {});
          } else {
              setActiveCatalog({});
          }
      };
      fetchCat();
  }, [managingMfg]);

  // --- ACTIONS ---

  const handleAddMfg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMfgName) return;
    const newMfg: Manufacturer = {
      id: crypto.randomUUID(),
      name: newMfgName,
      basePricingMultiplier: 1.0,
      tiers: [{ id: 'default', name: 'Standard', multiplier: 1.0 }],
      series: [],
      options: [],
      files: [],
      catalogImages: [],
      skuCount: 0
    };
    try {
      await storage.saveManufacturer(newMfg, {});
      const updatedList = await storage.getManufacturers();
      setManufacturers(updatedList);
      setShowAddModal(false);
      setNewMfgName('');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteMfg = async (id: string) => {
    setDeletingId(id);
    try {
      await storage.deleteManufacturer(id);
      setManufacturers(prev => prev.filter(m => m.id !== id));
      if (managingMfg?.id === id) setManagingMfg(null);
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
      // Refresh list if failed
      setManufacturers(await storage.getManufacturers());
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!managingMfg) return;
    setDeletingFileId(fileId);

    const updatedFiles = (managingMfg.files || []).filter(f => f.id !== fileId);
    
    // Note: This only removes the file record. Removing merged SKUs is not supported without re-upload.
    const updatedMfg: Manufacturer = {
        ...managingMfg,
        files: updatedFiles
    };

    try {
        await storage.saveManufacturerMetadata(updatedMfg);
        setManagingMfg(updatedMfg);
        setManufacturers(prev => prev.map(m => m.id === updatedMfg.id ? updatedMfg : m));
    } catch (err: any) {
        console.error("Delete failed", err);
        alert("Failed to delete file: " + err.message);
    } finally {
        setDeletingFileId(null);
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleNKBAUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadingId('nkba');
      setUploadStatus("Uploading NKBA Rules...");
      try {
        const base64Data = await readFileAsBase64(file);
        const newRules: NKBARules = {
          filename: file.name,
          uploadDate: new Date().toISOString(),
          size: file.size,
          isActive: true,
          data: base64Data
        };
        await storage.saveNKBARules(newRules);
        setNkbaRules(newRules);
      } catch (err: any) {
        console.error(err);
        alert(err.message || "Failed to upload file.");
      } finally {
        setUploadingId(null);
        setUploadStatus("");
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const handleMfgFileUpload = async (type: 'pricing' | 'spec', e: React.ChangeEvent<HTMLInputElement>) => {
    // Dynamic Import for heavy libraries
    const XLSX = await import('xlsx');
    const JSZip = (await import('jszip')).default;

    if (!managingMfg || !e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    
    setUploadingId(managingMfg.id);
    setUploadStatus(`Processing ${files.length} file(s)...`);
    await storage.ensureBucket();

    try {
      let updatedCatalog = { ...activeCatalog };
      let updatedTiers = [...managingMfg.tiers];
      let updatedSeries = [...(managingMfg.series || [])];
      let updatedOptions = [...(managingMfg.options || [])];
      let allImages: string[] = [...(managingMfg.catalogImages || [])];
      const newFiles: ManufacturerFile[] = [];

      // OPTIMIZATION: Process uploads SEQUENTIALLY to prevent UI freezing
      // Parallel processing of heavy Excel/PDF files locks the main thread
      for (let i = 0; i < files.length; i++) {
          const file = files[i];
          setUploadStatus(`Processing ${file.name} (${i + 1}/${files.length})...`);
          
          const newFile: ManufacturerFile = {
              id: `file_${Date.now()}_${i}`,
              name: file.name,
              type,
              uploadDate: new Date().toISOString(),
              size: file.size,
              url: undefined
          };

          if (type === 'spec') {
              try {
                  const url = await storage.uploadSpecBook(managingMfg.id, file);
                  newFile.url = url;

                  // AI EXTRACTION OF SPECS
                  setUploadStatus(`AI Analyzing Spec Book ${file.name} (This may take a minute)...`);
                  await new Promise(resolve => setTimeout(resolve, 50)); // Yield to UI
                  
                  const extractedSpecs = await extractManufacturerSpecs(file);
                  
                  let flatOptions: any[] = [];
                  if (extractedSpecs && Array.isArray(extractedSpecs.specificationSections)) {
                      // NEW FORMAT: Flatten the structured specs into simple options for now
                      extractedSpecs.specificationSections.forEach((sec: any) => {
                          // Map Section Name to Category
                          let cat = sec.section;
                          if (cat.toLowerCase().includes('door')) cat = 'DoorStyle';
                          else if (cat.toLowerCase().includes('finish') || cat.toLowerCase().includes('paint')) cat = 'Finish';
                          else if (cat.toLowerCase().includes('construction')) cat = 'Construction';
                          else if (cat.toLowerCase().includes('drawer')) cat = 'Drawer';
                          else if (cat.toLowerCase().includes('hinge')) cat = 'Hinge';

                          if (Array.isArray(sec.options)) {
                              sec.options.forEach((opt: any) => {
                                  if (typeof opt === 'string') {
                                      flatOptions.push({ name: opt, category: cat });
                                  } else if (typeof opt === 'object') {
                                      if (opt.name) {
                                          flatOptions.push({ 
                                              name: opt.name, 
                                              category: cat, 
                                              description: opt.series ? `${opt.series} Series` : opt.description 
                                          });
                                      }
                                      
                                      // Handle Dependent Finishes (e.g. inside a Door Style option)
                                      if (opt.finishes) {
                                          Object.keys(opt.finishes).forEach(finishType => {
                                              const finishes = opt.finishes[finishType];
                                              if (Array.isArray(finishes)) {
                                                  finishes.forEach(f => {
                                                      flatOptions.push({ name: f, category: 'Finish', description: `${finishType} (for ${opt.name || 'Door'})` });
                                                  });
                                              }
                                          });
                                      }
                                  }
                              });
                          }
                      });
                      
                      console.log(`AI found ${flatOptions.length} flattened spec options from new structure`);
                  } else if (Array.isArray(extractedSpecs)) {
                      // OLD FORMAT FALLBACK
                      flatOptions = extractedSpecs;
                  }

                  if (flatOptions.length > 0) {
                      const newOptions: ManufacturerOption[] = flatOptions.map((spec, idx) => ({
                          id: `spec_ai_${Date.now()}_${idx}`,
                          name: spec.name,
                          category: spec.category as any, 
                          section: 'A-Context', 
                          pricingType: 'included',
                          price: 0,
                          description: spec.description,
                          sourceSheet: file.name
                      }));
                      
                      // Merge new options, avoiding exact duplicates
                      newOptions.forEach(opt => {
                          const exists = updatedOptions.find(o => o.name === opt.name && o.category === opt.category);
                          if (!exists) {
                              updatedOptions.push(opt);
                          }
                      });
                  }

              } catch (e) {
                  console.error(`Failed to upload/process spec ${file.name}`, e);
                  alert(`Spec upload failed or AI could not read file: ${e.message}`);
              }
          }

          else if (type === 'pricing') {
              try {
                // Large File Warning
                if (file.size > 50 * 1024 * 1024) {
                    if (!window.confirm(`File ${file.name} is large (${(file.size/1024/1024).toFixed(1)}MB). This may freeze the browser momentarily. Continue?`)) continue;
                }

                setUploadStatus(`Reading ${file.name}...`);
                // Yield to UI before heavy operation
                await new Promise(resolve => setTimeout(resolve, 50));
                
                const ab = await readFileAsArrayBuffer(file);
                
                setUploadStatus(`Parsing Excel Structure (Please wait)...`);
                // Yield again
                await new Promise(resolve => setTimeout(resolve, 50));

                const workbook = XLSX.read(ab);
                
                // Track headers and count across all sheets in this workbook
                const foundPriceHeaders = new Set<string>();
                let parsedCount = 0;

                // Process sheets sequentially with UI breathing room
                for (let sIdx = 0; sIdx < workbook.SheetNames.length; sIdx++) {
                    const sheetName = workbook.SheetNames[sIdx];
                    
                    // UI Breathing: Allow React to render progress updates
                    if (sIdx % 2 === 0) await new Promise(r => setTimeout(r, 0));
                    setUploadStatus(`Processing ${file.name} - Sheet: ${sheetName} (${sIdx + 1}/${workbook.SheetNames.length})...`);

                    const sheet = workbook.Sheets[sheetName];
                    if (!sheet['!ref']) continue;
                    
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[][];
                    if (!rows || rows.length < 2) continue; 

                    // --- ADVANCED STRUCTURE DETECTION (UPDATED) ---
                    // Supports:
                    // 1. "Black Box" Collection Headers (Row 0/1) with Merge Filling
                    // 2. Vertical Text Door Styles (SKU Row)
                    // 3. Multi-style columns (Split by newline/slash)

                    // Step 1: Find SKU Row
                    let skuRowIndex = -1;
                    let skuColIndex = -1;
                    
                    for (let r = 0; r < Math.min(rows.length, 20); r++) {
                        const rowStr = rows[r].map(c => String(c).trim()).join(' ').toLowerCase();
                        if (rowStr.match(/sku|item|model|part|code|nomenclature/i)) {
                            const idx = rows[r].findIndex((c:any) => String(c).match(/sku|item|model|part|code|nomenclature/i));
                            if (idx !== -1) {
                                skuRowIndex = r;
                                skuColIndex = idx;
                                break;
                            }
                        }
                    }

                    if (skuRowIndex === -1) continue; // Skip sheet if no SKU row found

                    // Step 2: Map Columns to Collection & Door Styles
                    // Logic: Look at rows ABOVE skuRowIndex for Collection
                    // Look at skuRowIndex (Vertical Text) for Door Styles
                    
                    const columnMap: Record<number, { collection: string, styles: string[] }> = {};
                    let lastCollection = "Standard";

                    const headerRow = rows[skuRowIndex];
                    
                    // Iterate columns starting after SKU
                    for (let c = skuColIndex + 1; c < headerRow.length; c++) {
                        // A. Find Collection (Look upwards from SKU row)
                        // Heuristic: Scan rows 0 to skuRowIndex-1. 
                        // If a value exists in this column, update lastCollection.
                        // If empty, use lastCollection (Fill Forward).
                        let foundCollectionInCol = false;
                        for (let r = 0; r < skuRowIndex; r++) {
                            const cellVal = String(rows[r][c] || "").trim();
                            if (cellVal && cellVal.length > 2 && !cellVal.match(/price|cost|page|option|spec|feature|construction|description|note|width|height|depth|qty/i)) {
                                lastCollection = cellVal; // Found a new collection block
                                foundCollectionInCol = true;
                                break; // Use the top-most non-empty value? Or bottom-most? 
                                       // Usually "Black Box" is top-most.
                            }
                        }
                        // If no value found in this column, we assume it belongs to the previous 'lastCollection' (Merge behavior)
                        
                        // B. Find Door Styles (Vertical Text in SKU Row)
                        const styleCell = String(headerRow[c] || "").trim();
                        if (!styleCell || styleCell.match(/width|height|depth|qty|page|desc|note/i)) continue;

                        // Split by Newline or Slash for multi-style columns
                        // e.g. "Abilene Cherry\nBelcourt Cherry"
                        const styles = styleCell.split(/[\n\/]/).map(s => s.trim()).filter(s => s.length > 0);
                        
                        if (styles.length > 0) {
                            columnMap[c] = {
                                collection: lastCollection,
                                styles: styles
                            };
                        }
                    }

                    // Step 3: Process Data Rows
                    for (let r = skuRowIndex + 1; r < rows.length; r++) {
                        const row = rows[r];
                        if (!row[skuColIndex]) continue;

                        const rawSku = String(row[skuColIndex]);
                        if (rawSku.match(/sku|item|page|total/i) || rawSku.length < 2) continue;

                        const cleanSku = normalizeImportSku(rawSku);
                        if (!cleanSku) continue;

                        if (!updatedCatalog[cleanSku]) updatedCatalog[cleanSku] = {};

                        let rowHasPrice = false;

                        // Iterate mapped columns
                        Object.keys(columnMap).forEach(colIdxStr => {
                            const colIdx = parseInt(colIdxStr);
                            const rawPrice = row[colIdx];
                            if (!rawPrice) return;

                            const price = parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
                            if (!isNaN(price) && price > 0) {
                                rowHasPrice = true;
                                const mapping = columnMap[colIdx];
                                
                                // Create entries for ALL styles in this column
                                mapping.styles.forEach(style => {
                                    const tierName = mapping.collection !== "Standard"
                                        ? `${mapping.collection} - ${style}`
                                        : style;
                                    
                                    updatedCatalog[cleanSku][tierName] = price;
                                    foundPriceHeaders.add(tierName);
                                });
                            }
                        });
                        
                        if (rowHasPrice) parsedCount++;
                    }

                    // Fallback: If advanced parsing failed (parsedCount == 0), try Simple List Detection
                    if (parsedCount === 0) {
                         // Simple List Strategy:
                         // Look for rows that have SKU (Col A or similar) and Price (Col B or similar)
                         // But skip header rows.
                         
                         let simpleSkuCol = -1;
                         let simplePriceCol = -1;
                         let startRow = -1;

                         // Scan for headers first
                         for(let r=0; r<Math.min(rows.length, 20); r++) {
                             const rowStr = rows[r].map(c => String(c).trim().toLowerCase()).join(' ');
                             if (rowStr.match(/sku|item|code|model|part/)) {
                                 simpleSkuCol = rows[r].findIndex(c => String(c).match(/sku|item|code|model|part/i));
                                 // Look for price in same row
                                 simplePriceCol = rows[r].findIndex(c => String(c).match(/price|list|msrp|cost/i));
                                 if (simpleSkuCol !== -1) {
                                     startRow = r + 1;
                                     break;
                                 }
                             }
                         }

                         // If no headers found, assume Col 0 = SKU, Col 1 = Price (if numeric)
                         if (simpleSkuCol === -1) {
                             // Heuristic check on row 5 (random data row)
                             if (rows.length > 5) {
                                 const r5 = rows[5];
                                 if (r5[0] && String(r5[0]).length > 2 && !String(r5[1]).match(/[a-z]/i) && parseFloat(String(r5[1])) > 0) {
                                     simpleSkuCol = 0;
                                     simplePriceCol = 1;
                                     startRow = 1;
                                 }
                             }
                         }
                         
                         // If we found columns, parse simple list
                         if (simpleSkuCol !== -1) {
                             for (let r = startRow; r < rows.length; r++) {
                                 const row = rows[r];
                                 if (!row) continue;
                                 const rawSku = String(row[simpleSkuCol] || "");
                                 if (!rawSku || rawSku.length < 2 || rawSku.match(/sku|item|page/i)) continue;
                                 
                                 // Find price
                                 let price = 0;
                                 if (simplePriceCol !== -1) {
                                     price = parseFloat(String(row[simplePriceCol]).replace(/[^0-9.]/g, ''));
                                 } else {
                                     // Scan for first numeric column
                                     for (let c = simpleSkuCol + 1; c < row.length; c++) {
                                         const val = parseFloat(String(row[c]).replace(/[^0-9.]/g, ''));
                                         if (!isNaN(val) && val > 0) {
                                             price = val;
                                             break;
                                         }
                                     }
                                 }

                                 if (price > 0) {
                                     const cleanSku = normalizeImportSku(rawSku);
                                     if (!cleanSku) continue;
                                     
                                     if (!updatedCatalog[cleanSku]) updatedCatalog[cleanSku] = {};
                                     // Use Sheet Name as Tier Name for these simple lists
                                     // e.g. "Accessories" sheet -> Tier "Accessories"
                                     const tierName = sheetName.trim();
                                     updatedCatalog[cleanSku][tierName] = price;
                                     foundPriceHeaders.add(tierName);
                                     parsedCount++;
                                 }
                             }
                         }
                    }

                    if (parsedCount > 0) {
                        const newTiers: PricingTier[] = Array.from(foundPriceHeaders).map(header => {
                            // Extract Collection for Metadata
                            const parts = header.split(' - ');
                            const collection = parts.length > 1 ? parts[0] : undefined;
                            return {
                                id: header, 
                                name: header, 
                                multiplier: 1.0,
                                collection: collection
                            };
                        });
                        newTiers.forEach(nt => {
                            if (!updatedTiers.find(t => t.name === nt.name)) updatedTiers.push(nt);
                        });
                    }

                    } // End of Sheet Loop

                    // Async Image Extraction (Run ONCE per file, not per sheet)
                    try {
                        const zip = await JSZip.loadAsync(ab);
                        const mediaFolder = zip.folder("xl/media");
                        if (mediaFolder) {
                            const imageEntries: { path: string, entry: JSZip.JSZipObject }[] = [];
                            mediaFolder.forEach((relativePath, zipEntry) => {
                                if (relativePath.match(/\.(png|jpg|jpeg|gif)$/i)) imageEntries.push({ path: relativePath, entry: zipEntry });
                            });
                            
                            // Limit images to prevent freezing
                            const MAX_IMAGES = 10; 
                            const limitedImages = imageEntries.slice(0, MAX_IMAGES);
                            
                            // Sequential background upload to avoid flooding
                            for (const item of limitedImages) {
                                 try {
                                     const blob = await item.entry.async("blob");
                                     // Fire and forget individual uploads to speed up main thread? 
                                     // No, let's await them with a small delay to keep UI responsive
                                     storage.uploadCatalogImage(managingMfg.id, item.path.replace(/\//g, '_'), blob)
                                        .then(url => { if (url) allImages.push(url); })
                                        .catch(e => console.warn("Image bg upload fail", e));
                                     
                                     await new Promise(r => setTimeout(r, 10));
                                 } catch (e) { console.warn("Image extraction fail", e); }
                            }
                        }
                    } catch (zipErr) {
                        console.warn("Image extraction skipped for " + file.name, zipErr);
                    }

                  } catch (parseErr: any) {
                      console.error("Parsing failed for " + file.name, parseErr);
                  }
              }
              
              newFiles.push(newFile);
       }

      const updatedMfg: Manufacturer = {
        ...managingMfg,
        tiers: updatedTiers,
        series: updatedSeries,
        options: updatedOptions,
        catalogImages: allImages, 
        files: [...(managingMfg.files || []), ...newFiles],
        skuCount: Object.keys(updatedCatalog).length
      };

      setUploadStatus("Saving All Changes...");
      await new Promise(r => setTimeout(r, 50));
      await storage.saveManufacturer(updatedMfg, updatedCatalog);
      
      setManagingMfg(updatedMfg);
      setActiveCatalog(updatedCatalog);
      setManufacturers(await storage.getManufacturers());
      
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed to upload files.");
    } finally {
      setUploadingId(null);
      setUploadStatus("");
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')} className="shrink-0">
             <ArrowLeft className="w-5 h-5 text-slate-500" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
            <p className="text-slate-500 mt-1">Manage manufacturer pricing & specs.</p>
          </div>
        </div>
        <Button onClick={() => setShowAddModal(true)} className="gap-2 w-full sm:w-auto">
          <Plus className="w-4 h-4" /> Add Manufacturer
        </Button>
      </div>

      <div className="grid gap-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-[200px]">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
            <h2 className="font-semibold text-slate-800">Active Manufacturers</h2>
            <span className="text-xs font-medium text-slate-500 bg-slate-200 px-2 py-1 rounded-full">{manufacturers.length} Total</span>
          </div>
          
          {manufacturers.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center text-slate-400">
               <AlertTriangle className="w-12 h-12 mb-4 text-slate-300" />
               <p className="font-medium text-slate-600">No Manufacturers Configured</p>
               <Button variant="outline" className="mt-6" onClick={() => setShowAddModal(true)}>Add First</Button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {manufacturers.map((mfg) => (
                  <div key={mfg.id} className="p-6 flex items-start justify-between hover:bg-slate-50 transition-colors">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center font-bold text-slate-400">
                          {mfg.name.substring(0,2).toUpperCase()}
                        </div>
                        <div>
                          <h3 className="font-bold text-slate-900">{mfg.name}</h3>
                          {mfg.dealerName && (
                              <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                                  <Building2 className="w-3 h-3"/> {mfg.dealerName}
                              </div>
                          )}
                          <div className="flex gap-2 text-xs text-slate-500 mt-1">
                             {(mfg.skuCount || 0) > 0 && (
                               <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-100 flex items-center gap-1">
                                  <Database className="w-3 h-3"/> {mfg.skuCount?.toLocaleString()} SKUs
                               </span>
                             )}
                             {(mfg.options?.length || 0) > 0 && (
                               <span className="bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-100 flex items-center gap-1">
                                  <Settings2 className="w-3 h-3"/> {mfg.options.length} Options
                               </span>
                             )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button variant="outline" size="sm" onClick={() => setManagingMfg(mfg)}>Manage Files</Button>
                      <button 
                         type="button"
                         onClick={(e) => {
                             e.stopPropagation();
                             handleDeleteMfg(mfg.id);
                         }} 
                         className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                         title="Delete Manufacturer & All Data"
                      >
                        {deletingId === mfg.id ? <Loader2 className="w-4 h-4 animate-spin"/> : <Trash2 className="w-4 h-4"/>}
                      </button>
                    </div>
                  </div>
              ))}
            </div>
          )}
        </div>

        {/* NKBA Rules Section */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
           <h2 className="font-semibold text-slate-800 mb-4">NKBA Rules Management</h2>
           <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleNKBAUpload} />
           
           {!nkbaRules ? (
             <div onClick={() => fileInputRef.current?.click()} className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center hover:bg-brand-50 cursor-pointer">
                <Upload className="w-6 h-6 mx-auto mb-2 text-slate-400" />
                <p className="text-sm font-medium">{uploadingId === 'nkba' ? (uploadStatus || 'Uploading...') : 'Upload NKBA Standards PDF'}</p>
             </div>
           ) : (
             <div className="border border-green-200 bg-green-50 rounded-xl p-6 flex justify-between items-center">
                <div>
                    <h3 className="font-bold text-slate-900">{nkbaRules.filename}</h3>
                    <p className="text-xs text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3"/> Active</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>Replace</Button>
             </div>
           )}
        </div>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold mb-4">Add New Manufacturer</h3>
            <form onSubmit={handleAddMfg}>
              <div className="space-y-4 mb-6">
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Manufacturer Name</label>
                    <input 
                        autoFocus className="w-full border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-brand-500 outline-none"
                        placeholder="e.g. Aspire Cabinetry" value={newMfgName} onChange={e => setNewMfgName(e.target.value)} required
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Dealer / Distributor Name (Optional)</label>
                    <input 
                        className="w-full border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-brand-500 outline-none"
                        placeholder="e.g. Local Lumber Yard" value={newDealerName} onChange={e => setNewDealerName(e.target.value)}
                    />
                    <p className="text-xs text-slate-500 mt-1">Group this manufacturer under a specific dealer.</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setShowAddModal(false)}>Cancel</Button>
                <Button type="submit">Create</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Files Modal */}
      {managingMfg && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="text-xl font-bold">Manage {managingMfg.name}</h3>
              <button onClick={() => setManagingMfg(null)}><X className="w-6 h-6 text-slate-400"/></button>
            </div>
            <div className="p-6 overflow-y-auto space-y-8 flex-1">
              <section>
                 <div className="flex justify-between mb-4">
                    <div>
                        <h4 className="font-semibold text-slate-800 flex items-center gap-2"><FileSpreadsheet className="w-5 h-5 text-green-600"/> Pricing Sheets</h4>
                        <p className="text-xs text-slate-500">Supports .xlsx and .xlsm (Macro Enabled). Images will be extracted.</p>
                    </div>
                    <input type="file" ref={pricingInputRef} className="hidden" accept=".xlsx,.xlsm,.xls" multiple onChange={(e) => handleMfgFileUpload('pricing', e)} />
                    <Button size="sm" variant="outline" onClick={() => pricingInputRef.current?.click()} isLoading={uploadingId === managingMfg.id}>
                         {uploadingId === managingMfg.id ? (
                             <>
                                <Sparkles className="w-4 h-4 mr-2 animate-pulse text-brand-500"/>
                                {uploadStatus || "Processing..."}
                             </>
                         ) : (
                             "Upload .xlsm / .xlsx"
                         )}
                    </Button>
                 </div>
                 
                 {/* Image Gallery Preview */}
                 {managingMfg.catalogImages && managingMfg.catalogImages.length > 0 && (
                     <div className="mb-4">
                         <h5 className="text-sm font-semibold text-slate-700 mb-2">Extracted Asset Gallery ({managingMfg.catalogImages.length})</h5>
                         <div className="grid grid-cols-6 gap-2 h-24 overflow-hidden relative">
                             {managingMfg.catalogImages.slice(0, 12).map((url, i) => (
                                 <div key={i} className="aspect-square bg-slate-100 rounded border border-slate-200 overflow-hidden">
                                     <img src={url} alt="asset" className="w-full h-full object-cover" />
                                 </div>
                             ))}
                             {managingMfg.catalogImages.length > 12 && (
                                 <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent flex items-end justify-center">
                                     <span className="text-xs font-bold text-slate-500 bg-white/80 px-2 rounded">+ {managingMfg.catalogImages.length - 12} more</span>
                                 </div>
                             )}
                         </div>
                     </div>
                 )}

                 <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                    {(managingMfg.files || []).filter(f => f.type === 'pricing').map(f => (
                        <div key={f.id} className="text-sm py-2 flex items-center justify-between group border-b border-slate-100 last:border-0 hover:bg-slate-50 px-2 rounded">
                            <div className="flex items-center gap-2">
                                <CheckCircle className="w-3 h-3 text-green-500"/> 
                                <span className="font-medium text-slate-700">{f.name}</span>
                                <span className="text-[10px] text-slate-400">({new Date(f.uploadDate).toLocaleDateString()})</span>
                            </div>
                            <button 
                                type="button"
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    handleDeleteFile(f.id); 
                                }}
                                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                disabled={deletingFileId === f.id}
                                title="Delete File Record"
                            >
                                {deletingFileId === f.id ? <Loader2 className="w-4 h-4 animate-spin text-red-500"/> : <Trash2 className="w-4 h-4"/>}
                            </button>
                        </div>
                    ))}
                    {(!managingMfg.files?.some(f => f.type === 'pricing')) && <p className="text-sm text-slate-400 italic">No pricing files uploaded.</p>}
                 </div>
              </section>

              {/* Spec Books Section */}
              <section>
                 <div className="flex justify-between mb-4">
                    <div>
                        <h4 className="font-semibold text-slate-800 flex items-center gap-2"><FileText className="w-5 h-5 text-blue-600"/> Spec Books (PDF)</h4>
                        <p className="text-xs text-slate-500">Upload PDF Spec Books. These can be scanned for rules & dimensions.</p>
                    </div>
                    <input type="file" ref={specInputRef} className="hidden" accept=".pdf" multiple onChange={(e) => handleMfgFileUpload('spec', e)} />
                    <Button size="sm" variant="outline" onClick={() => specInputRef.current?.click()} isLoading={uploadingId === managingMfg.id}>
                         {uploadingId === managingMfg.id && uploadStatus.includes('Spec') ? (
                             <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin"/>
                                {uploadStatus}
                             </>
                         ) : (
                             "Upload PDF"
                         )}
                    </Button>
                 </div>
                 
                 <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                    {(managingMfg.files || []).filter(f => f.type === 'spec').map(f => (
                        <div key={f.id} className="text-sm py-2 flex items-center justify-between group border-b border-slate-100 last:border-0 hover:bg-slate-50 px-2 rounded">
                            <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-blue-500"/> 
                                <span className="font-medium text-slate-700">{f.name}</span>
                                <span className="text-[10px] text-slate-400">({new Date(f.uploadDate).toLocaleDateString()})</span>
                                {f.url && (
                                    <a href={f.url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline ml-2">View</a>
                                )}
                            </div>
                            <button 
                                type="button"
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    handleDeleteFile(f.id); 
                                }}
                                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                disabled={deletingFileId === f.id}
                                title="Delete File Record"
                            >
                                {deletingFileId === f.id ? <Loader2 className="w-4 h-4 animate-spin text-red-500"/> : <Trash2 className="w-4 h-4"/>}
                            </button>
                        </div>
                    ))}
                    {(!managingMfg.files?.some(f => f.type === 'spec')) && <p className="text-sm text-slate-400 italic">No spec books uploaded.</p>}
                 </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};