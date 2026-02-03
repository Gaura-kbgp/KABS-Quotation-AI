import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Plus, Upload, FileSpreadsheet, FileText, AlertTriangle, CheckCircle, RefreshCw, X, Loader2, Database, Image as ImageIcon, Settings2, Sparkles, ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '../components/Button';
import { Manufacturer, ManufacturerFile, NKBARules, PricingTier, ManufacturerOption, CabinetSeries, WorkbookSection } from '../types';
import { storage } from '../services/storage';
import { determineExcelStructure } from '../services/ai';
import { normalizeNKBACode } from '../services/pricingEngine';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

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
              } catch (e) {
                  console.error(`Failed to upload spec ${file.name}`, e);
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

                    // Determine structure (lightweight AI call or heuristic)
                    let structure: any = { skuColumn: null, priceColumns: [], optionTableType: null };
                    
                    // Use Heuristics FIRST to save time
                    const headerRowIdx = rows.findIndex(r => r.some((c:any) => 
                        String(c).match(/sku|item|product|code|model|part|cabinet|number|no\.|key/i)
                    ));
                    
                    if (headerRowIdx !== -1) {
                         const headerRow = rows[headerRowIdx].map(String);
                         structure.skuColumn = headerRow.findIndex(c => c.match(/sku|item|product|code|model|part|cabinet|number|no\.|key/i));
                         
                         // Find price columns
                         headerRow.forEach((h, idx) => {
                             // Enhanced Price Detection
                             if ((h.match(/price|cost|list|msrp|amount|rate|net/i) || h.includes('$')) && !h.match(/code|sku|model|part|page/i)) {
                                 structure.priceColumns.push({ index: idx, name: h });
                             }
                         });
                    }

                    // Fallback to AI if heuristics fail
                    if (structure.skuColumn === null || structure.priceColumns.length === 0) {
                             if (rows.length > 200) {
                                 const sample = [
                                     ...rows.slice(0, 20),
                                     ...rows.slice(Math.floor(rows.length/2), Math.floor(rows.length/2) + 20)
                                 ];
                                 structure = await determineExcelStructure(sheetName, sample);
                             } else {
                                 structure = await determineExcelStructure(sheetName, rows);
                             }
                        }

                        if (structure.skuColumn !== null && structure.priceColumns.length > 0) {
                            const skuCol = structure.skuColumn;
                            
                            // Process Rows
                            rows.slice(headerRowIdx + 1).forEach(row => {
                                const rawVal = String(row[skuCol] || "").trim();
                                if (!rawVal || rawVal.length < 2 || rawVal.match(/^page/i)) return;

                                // Normalize SKU Key for consistent lookup
                                const cleanSku = normalizeImportSku(rawVal);
                                if (!cleanSku) return;

                                if (!updatedCatalog[cleanSku]) updatedCatalog[cleanSku] = {};

                                structure.priceColumns.forEach((pc: any) => {
                                    const priceVal = parseFloat(String(row[pc.index]).replace(/[^0-9.]/g, ''));
                                    if (!isNaN(priceVal) && priceVal > 0) {
                                        // If sheet has a specific Door Style (e.g. "Ashland"), prefix it
                                        const stylePrefix = structure.doorStyleName ? `${structure.doorStyleName} - ` : "";
                                        const fullTierName = stylePrefix + pc.name;
                                        updatedCatalog[cleanSku][fullTierName] = priceVal;
                                        foundPriceHeaders.add(fullTierName);
                                    }
                                });
                                parsedCount++;
                            });
                        }

                    if (parsedCount > 0) {
                        const newTiers: PricingTier[] = Array.from(foundPriceHeaders).map(header => ({
                            id: header, name: header, multiplier: 1.0
                        }));
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

              {/* Options Discovery Audit */}
              <section>
                 <h4 className="font-semibold text-slate-800 mb-2 mt-6">Discovered Options ({managingMfg.options?.length || 0})</h4>
                 <div className="max-h-60 overflow-y-auto border border-slate-200 rounded p-2 text-xs space-y-1">
                     {managingMfg.options?.map(o => (
                         <div key={o.id} className="flex justify-between items-center bg-slate-50 p-1 rounded">
                             <div className="flex flex-col">
                                 <span className="font-medium">{o.name}</span>
                                 <span className="text-slate-400 text-[10px]">{o.category} • {o.section}</span>
                             </div>
                             <span className="font-mono text-slate-500">
                                 {o.pricingType === 'percentage' ? `${(o.price*100).toFixed(1)}%` : `+$${o.price}`}
                             </span>
                         </div>
                     ))}
                     {(!managingMfg.options || managingMfg.options.length === 0) && <p className="text-slate-400">No options discovered yet.</p>}
                 </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};