import { GoogleGenAI } from "@google/genai";
import { CabinetItem, ProjectSpecs, CabinetType } from "../types";
import { normalizeNKBACode } from "./pricingEngine";

// Using import.meta.env.VITE_GEMINI_API_KEY as per guidelines
const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

// Updated to 2.5 series as per user request (2026 models)
const MODEL_NAME = 'gemini-2.5-flash'; // Switched to Flash for speed
const PRO_MODEL_NAME = 'gemini-2.5-pro'; // Keep Pro as fallback/option 

const SYSTEM_INSTRUCTION = `
You are KABS Quotation AI, an expert kitchen cabinet estimator.

GOAL: Extract EVERY cabinet code from the provided document (PDF or Images).
INPUT: Either extracted text from a PDF OR a sequence of images.
OUTPUT: A JSON object with "scratchpad", "specs", and "items".

INTELLIGENCE RULES:
1.  **Analyze All Input**: If text is provided, read it all. If images are provided, analyze every page.
2.  **Find Codes**: Identify cabinet codes (e.g., "B30", "W3030", "VDB27", "SB36").
3.  **Infer Missing Codes**: If a cabinet has dimensions but no code (e.g., a 30" wide Base), construct the code "B30". Use "W{width}{height}" for walls.
4.  **Filter Noise**: Exclude appliances (Fridge, Stove, DW) unless they are cabinet enclosures/panels. Exclude electrical/plumbing symbols.
5.  **Grouping**: Group findings by page in the "scratchpad" field.
6.  **Deduplicate**: If the SAME cabinet appears multiple times (e.g. Plan vs Elevation), count it ONLY ONCE.
7.  **Text Mode**: If analyzing raw text, assume it is a Cabinet List/Quote. Extract the codes and quantities directly.

Your extraction must be exhaustive and accurate.
`;

// Helper: Consolidate identical items to prevent duplicates from multiple views
function consolidateItems(items: any[]): any[] {
    const map = new Map<string, any>();

    items.forEach(item => {
        // Create a unique key for aggregation
        // We normalize the code to uppercase and remove spaces
        const normCode = (item.normalizedCode || item.originalCode || "").toUpperCase().replace(/\s+/g, '');
        // We round dimensions to avoid floating point mismatches (e.g. 30.0 vs 30)
        const w = Math.round(item.width || 0);
        const h = Math.round(item.height || 0);
        const d = Math.round(item.depth || 0);
        // We sort modifications to ensure order doesn't matter
        const mods = (item.modifications || []).map((m: any) => (m.description || "").trim()).sort().join('|');
        
        // Key includes type to differentiate Base vs Wall if codes are ambiguous
        const key = `${normCode}_${item.type}_${w}x${h}x${d}_${mods}`;

        if (map.has(key)) {
            const existing = map.get(key);
            existing.quantity += (item.quantity || 1); // Fix: use item.quantity not item.qty (mapped items use quantity)
            // Merge notes if different
            if (item.notes && !existing.notes.includes(item.notes)) {
                existing.notes += "; " + item.notes;
            }
        } else {
            // Clone item to avoid mutation side effects
            map.set(key, { ...item, quantity: item.quantity || 1 });
        }
    });

    return Array.from(map.values());
}


// Helper to clean and parse JSON resiliently
function safeJSONParse(text: string): any {
    if (!text) return { items: [], specs: {} };
    
    // Remove code blocks
    let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // Fix 1: Trailing commas (e.g. [1, 2, ])
    clean = clean.replace(/,\s*([\]}])/g, '$1');

    // Fix 2: Missing commas between objects (e.g. }{ -> },{ )
    clean = clean.replace(/}\s*{/g, '},{');

    // Fix 3: Missing commas after array closing bracket before next key (e.g. ] "key": )
    clean = clean.replace(/]\s*"/g, '],"');

    // Fix 4: Missing comma between object closing and next key quote (e.g. } "next": )
    clean = clean.replace(/}\s*"/g, '},"');

    // Fix 5: Missing comma between strings (e.g. "a" "b" -> "a", "b")
    clean = clean.replace(/"\s*"/g, '","');

    // Fix 6: Missing comma after number in array (e.g. [1, 2] -> [1, 2])
    clean = clean.replace(/(\d+)\s+(\d+)/g, '$1, $2');

    // Fix 7: Missing comma after number before quote (e.g. 1 "a" -> 1, "a")
    clean = clean.replace(/(\d+)\s+"/g, '$1, "');

    // Fix 8: Round tiny floating point numbers (e.g. 3.000...e-21 -> 0)
    clean = clean.replace(/(\d+\.?\d*)e-[0-9]+/gi, '0');
    // Fix 9: Round long decimals (e.g. 33.000000001 -> 33)
    clean = clean.replace(/(\d+\.\d{4,})/g, (match) => {
        return String(Math.round(parseFloat(match) * 100) / 100);
    });

    // Fix 10: Missing comma between closing bracket and number (e.g. [1, 2] 3 -> [1, 2], 3)
    clean = clean.replace(/\]\s*(\d+)/g, '], $1');

    try {
        return JSON.parse(clean);
    } catch (e) {
        console.error("JSON Parse Failed. Raw text:", text.substring(0, 200) + "...");
        console.error("Cleaned text:", clean.substring(0, 200) + "...");
        console.error("Parse Error:", e);
        return { items: [], specs: {} };
    }
}

// Helper to strip Data URI prefix
function cleanBase64(data: string): string {
    if (data.includes(',')) {
        return data.split(',')[1];
    }
    return data;
}

// Helper: Sleep for retries
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry Wrapper for AI calls
async function callAIWithRetry<T>(
    operation: () => Promise<T>, 
    retries = 3, 
    delay = 2000
): Promise<T> {
    try {
        return await operation();
    } catch (error: any) {
        if (retries > 0) {
            console.warn(`AI Call Failed. Retrying in ${delay}ms... (${retries} left)`);
            await sleep(delay);
            return callAIWithRetry(operation, retries - 1, delay * 1.5);
        }
        throw error;
    }
}

// Helper: Resize image if too large (Gemini has limits)
const resizeImageIfNeeded = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target?.result as string;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_WIDTH = 3072; 
                const MAX_HEIGHT = 3072;

                if (width > MAX_WIDTH || height > MAX_HEIGHT) {
                    if (width > height) {
                        height = Math.round(height * (MAX_WIDTH / width));
                        width = MAX_WIDTH;
                    } else {
                        width = Math.round(width * (MAX_HEIGHT / height));
                        height = MAX_HEIGHT;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.9); // Higher quality
                resolve(cleanBase64(dataUrl));
            };
            img.onerror = (err) => reject(new Error("Failed to load image for resizing"));
        };
        reader.onerror = reject;
    });
}

import { convertPdfToImages, extractTextFromPdf } from "./pdfUtils";

// --- NEW: Local Heuristic Extraction to Bypass AI for Simple Lists ---
function tryLocalRegexExtraction(text: string): CabinetItem[] {
    const items: CabinetItem[] = [];
    const seenCodes = new Set<string>(); // avoid duplicates on same line
    
    // Pattern 1: Standard Cabinet Code (e.g. B30, W3030, VDB27AH-3)
    // Needs to be fairly strict to avoid matching random text
    // Matches: Start of word, [A-Z]{1,4} prefix, \d{2,} dimensions, optional suffix
    const codeRegex = /\b([A-Z]{1,4}\d{2,}[A-Z0-9-]*)\b/g;
    
    // Pattern 2: Tabular Quantity detection (Number at start of line or near code)
    // This is hard to do perfectly with regex, so we'll look for lines that have a code
    
    const lines = text.split('\n');
    
    for (const line of lines) {
        // Skip obvious junk lines
        if (line.length < 5) continue;
        if (line.includes('Page') && line.includes('of')) continue;
        
        const matches = [...line.matchAll(codeRegex)];
        if (matches.length === 0) continue;
        
        // Find quantity if possible (look for number before the code)
        let qty = 1;
        const qtyMatch = line.match(/^(\d+)\s+/); // Number at start of line
        if (qtyMatch) {
            qty = parseInt(qtyMatch[1], 10);
            if (qty > 100 || qty < 1) qty = 1; // Safety
        }
        
        for (const match of matches) {
            const code = match[1];
            // Filter invalid codes (like dates, years, phone numbers)
            if (code.match(/^\d{4}/)) continue; // Year like 2024
            if (code.length > 20) continue; // Too long
            
            // Basic Type Inference
            let type: CabinetType = 'Base';
            if (code.startsWith('W')) type = 'Wall';
            else if (code.startsWith('T') || code.startsWith('U')) type = 'Tall';
            else if (code.startsWith('V')) type = 'Accessory'; // Vanity or Valance
            
            items.push({
                id: `local_${Date.now()}_${items.length}`,
                originalCode: code,
                quantity: qty,
                type: type,
                description: "Fast Scan Item", // Placeholder
                width: 0, height: 0, depth: 0,
                normalizedCode: code
            });
        }
    }
    
    return items;
}

export async function extractManufacturerSpecs(file: File): Promise<any> {
    console.log("AI Spec Extraction: Starting...");
    const contentsParts: any[] = [];
    let processedWithText = false;

    // 1. FAST PATH: Text Extraction
    try {
         console.log("Attempting fast text extraction for Specs...");
         const rawText = await extractTextFromPdf(file);
         if (rawText.length > 200) {
             contentsParts.push({ text: `*** DOCUMENT TEXT EXTRACTED ***
             The user uploaded a Manufacturer Specification PDF.
             Below is the raw text content of the file.
             
             CRITICAL INSTRUCTION:
             1. Scan the ENTIRE text below.
             2. Extract ALL configurable cabinetry options as per the instructions.
             3. Note that the text may contain multiple pages separated by "--- PAGE X ---". You must read ALL pages.
             
             RAW TEXT CONTENT:
             ${rawText}
             ***` });
             processedWithText = true;
         }
    } catch (e) {
        console.warn("Spec Text Extraction failed, falling back to Vision", e);
    }
    
    // 2. SLOW PATH: Vision (Fallback)
    if (!processedWithText) {
        try {
            let mimeType = file.type;
            if (!mimeType) mimeType = file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';

            if (mimeType === 'application/pdf') {
                const pdfImages = await convertPdfToImages(file);
                // Limit to first 20 pages to avoid timeouts/limits, but user asked for "Read Full PDF"
                // Vision is expensive. If text failed, this is a scanned doc. 
                // We'll do 15 pages as a reasonable compromise for "Full PDF" in vision mode.
                const limit = Math.min(pdfImages.length, 15); 
                
                console.log(`Processing first ${limit} pages of Spec Book (Vision Mode)...`);
                
                for(let i=0; i<limit; i++) {
                    const img = pdfImages[i];
                    contentsParts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.data
                        }
                    });
                    contentsParts.push({ text: `[--- PAGE ${img.pageNumber} ---]` });
                }
            } else {
                const base64 = await resizeImageIfNeeded(file);
                contentsParts.push({ inlineData: { mimeType, data: base64 } });
            }
        } catch (e) {
            console.error("Spec Image Conversion Failed", e);
            throw new Error("Failed to process Spec file for AI analysis.");
        }
    }

    const SPEC_SYSTEM_INSTRUCTION = `
 You are a Senior Interior Quotation AI working for a professional cabinetry quotation system. 
 
 Your task is to READ and UNDERSTAND the uploaded Manufacturer Specification PDF 
 and dynamically generate a SPECIFICATION CONFIGURATION for a Kitchen Cabinet quotation UI. 
 
 ======================== 
 CONTEXT 
 ======================== 
 • User has selected a Manufacturer from a dropdown 
 • A manufacturer specification PDF is uploaded 
 • This PDF is the ONLY source of truth 
 • Ignore plumbing, electrical, appliances, delivery, warranty, and legal pages 
 • Focus ONLY on INTERIOR CABINETRY specifications 
 
 ======================== 
 OBJECTIVE 
 ======================== 
 When a manufacturer is selected: 
 1. Read the PDF completely 
 2. Extract ALL configurable cabinetry options 
 3. Convert them into a structured, dynamic specification form 
 4. Output JSON that can directly drive a React UI 
 
 ======================== 
 WHAT TO EXTRACT FROM PDF 
 ======================== 
 From the specification guide, identify and group: 
 
 1. Door Style 
    - Series (Elite / Premium / Prime / Choice) 
    - Door Style Name (Canyon, Durango, Abilene, etc.) 
    - Overlay type (Full Overlay / Partial Overlay) 
    - Panel type (Slab / Recessed / Raised / Mitered) 
    - OFD / DFO / MFD availability 
 
 2. Finish Options 
    - Wood species (Maple, Cherry, etc.) 
    - Painted finishes 
    - Duraform finishes 
    - Glaze finishes 
    - Mark Premium / Standard finishes 
    - Ensure only finishes VALID for the selected door style appear 
 
 3. Cabinet Construction 
    - Box material 
    - Shelves type 
    - Drawer system 
    - Hinge type 
    - Soft close options 
    - Toe kick options (Standard / Recessed / Void) 
    - All plywood option (if available) 
 
 4. Cabinet Categories (NO QUANTITY HERE) 
    - Base Cabinets 
    - Wall Cabinets 
    - Tall Cabinets 
    - Vanity Cabinets 
    - Accessories (only cabinetry-related) 
 
 5. Optional Upgrades 
    - CushionClose drawers 
    - CushionClose hinges 
    - Matching interior 
    - Full depth shelves 
    - Reduced / Increased depth 
    - Furniture ends 
    - Decorative panels 
 
 ======================== 
 STRICT RULES 
 ======================== 
 • DO NOT guess 
 • DO NOT hallucinate options not found in PDF 
 • DO NOT merge incompatible finishes or door styles 
 • If an option is not available for a door style → exclude it 
 • Ignore pricing unless explicitly mentioned as an option 
 • Output MUST be deterministic and structured 
 
 ======================== 
 OUTPUT FORMAT (MANDATORY) 
 ======================== 
 Return JSON ONLY in this structure: 
 
 { 
   "manufacturer": "Name Detected from PDF", 
   "specificationSections": [ 
     { 
       "section": "Door Style", 
       "type": "select", 
       "options": [ 
         { 
           "series": "Elite", 
           "name": "Canyon", 
           "overlay": "Full Overlay", 
           "panel": "Recessed", 
           "supports": ["OFD", "DFO"] 
         } 
       ] 
     }, 
     { 
       "section": "Finish", 
       "type": "dependent-select", 
       "dependsOn": "Door Style", 
       "options": [ 
         { 
           "doorStyle": "Canyon", 
           "finishes": { 
             "Painted": ["Oat", "Navy", "Sage"], 
             "Wood": ["Maple Cider", "Maple Latte"], 
             "Duraform": ["Breeze", "Drift"] 
           } 
         } 
       ] 
     }, 
     { 
       "section": "Construction Options", 
       "type": "checkbox-group", 
       "options": [ 
         "Soft Close Hinges", 
         "Soft Close Drawers", 
         "All Plywood Box", 
         "Matching Interior" 
       ] 
     }, 
     { 
       "section": "Toe Kick", 
       "type": "radio", 
       "options": ["Standard", "Recessed", "Void"] 
     } 
   ] 
 } 
 
 ======================== 
 FINAL INSTRUCTION 
 ======================== 
 Think like a cabinet manufacturer product engineer. 
 Accuracy is more important than completeness. 
 If data is missing → omit the option.
    `;

    contentsParts.push({ text: SPEC_SYSTEM_INSTRUCTION });

    const ai = getAI();
    // Using a simpler schema because the user's requested schema is complex and recursive/varied
    // We will let the prompt drive the structure and just request JSON
    const generationConfig = {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json"
    };

    try {
        const result = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: { parts: contentsParts },
            config: generationConfig
        });

        let text = "";
        const r = result as any;
        if (typeof r.text === 'function') text = r.text();
        else if (r.response && typeof r.response.text === 'function') text = r.response.text();
        else text = JSON.stringify(r);

        const parsed = safeJSONParse(text);
        return parsed;

    } catch (err) {
        console.error("AI Spec Extraction Error:", err);
        return { manufacturer: "Unknown", specificationSections: [] };
    }
}

export async function analyzePlan(file: File, nkbaRulesBase64?: string): Promise<{ 
    specs: ProjectSpecs, 
    items: CabinetItem[] 
}> {
    // Determine mime type first
    let mimeType = file.type;
    if (!mimeType || mimeType === '') {
        if (file.name.toLowerCase().endsWith('.pdf')) mimeType = 'application/pdf';
        else if (file.name.toLowerCase().endsWith('.png')) mimeType = 'image/png';
        else if (file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg')) mimeType = 'image/jpeg';
        else mimeType = 'application/pdf'; // Default to PDF if unknown
    }

    let contentsParts: any[] = [];

    // --- NEW LOGIC: PDF -> IMAGE CONVERSION ---
    if (mimeType === 'application/pdf') {
        let processedWithText = false;
        
        // 1. FAST PATH: Attempt Text Extraction & Local Regex Heuristics
        try {
             console.log("Attempting fast text extraction...");
             const rawText = await extractTextFromPdf(file);
             
             // --- INSTANT LOCAL EXTRACTION (BYPASS AI) ---
             const localItems = tryLocalRegexExtraction(rawText);
             if (localItems.length >= 5) {
                 console.log(`INSTANT SCAN SUCCESS: Found ${localItems.length} items using local regex. Bypassing AI.`);
                 // Return immediately with locally found items
                 return {
                     specs: {
                         manufacturer: "Detected from PDF (Fast Scan)",
                         notes: "Extracted via Fast Scan"
                     },
                     items: consolidateItems(localItems)
                 };
             }
             // --------------------------------------------

             // Heuristic: Does the text look like a cabinet list?
             // Look for patterns like B30, W3030, SB36, VDB, etc.
             // Also look for tabular headers like "Qty", "Description"
             const codeMatches = rawText.match(/\b(B\d{2}|W\d{4}|SB\d{2}|DB\d{2}|VDB|LS\d{2}|OC\d{2}|[A-Z]{1,3}\d{2,})\b/g) || [];
             const hasListKeywords = /Qty|Quantity|Description|Item|Schedule/i.test(rawText);
             
             // If we found significant codes (>5) and text length is substantial, use Text Only mode
             // Or if we found some codes AND list keywords, trust it more
             // This avoids the expensive image rendering step
             const isRichText = rawText.length > 200;
             const seemsLikeList = (codeMatches.length > 5) || (codeMatches.length > 2 && hasListKeywords);

             if (isRichText && seemsLikeList) {
                  console.log(`Fast Path: Detected ${codeMatches.length} potential codes. Skipping Image Rasterization.`);
                  
                  // Optimize Text: Collapse multiple spaces to one, but PRESERVE NEWLINES for list structure
                  const optimizedText = rawText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n');
                  
                  contentsParts.push({ text: `*** DOCUMENT TEXT EXTRACTED (OPTIMIZED) ***
                  The user uploaded a PDF that contains readable text (likely an Order Acknowledgment or Quote). 
                  Below is the raw text content of the file.
                  
                  CRITICAL INSTRUCTION:
                  1. Scan the ENTIRE text below.
                  2. Extract ALL cabinet codes found in the text.
                  3. IGNORE page headers/footers if they are just metadata.
                  4. Note that the text may contain multiple pages separated by "--- PAGE X ---". You must read ALL pages.
                  
                  RAW TEXT CONTENT:
                  ${optimizedText}
                  ***` });
                  
                  processedWithText = true;
             }
        } catch (textErr) {
             console.warn("Text extraction failed/inadequate, continuing to image processing...", textErr);
        }

        // 2. SLOW PATH: Vision Analysis (Fallback)
        if (!processedWithText) {
            try {
                console.log("Detecting PDF... Converting pages to images for improved AI recall...");
                const pdfImages = await convertPdfToImages(file);
                
                if (pdfImages.length === 0) {
                    throw new Error("PDF processing failed: No pages found.");
                }

                console.log(`Successfully converted ${pdfImages.length} PDF pages to images.`);

                // OPTIMIZATION: If too many pages (>20), fallback to text-only mode for the remaining pages or warn user
                // Or better: Only send the first 20 pages as images, and the rest as text if possible?
                // For now, let's limit to 15 images to prevent timeouts
                const MAX_IMAGES = 15;
                const imagesToProcess = pdfImages.slice(0, MAX_IMAGES);

                contentsParts.push({ text: `*** DOCUMENT INFO: This PDF contains ${pdfImages.length} pages. 
                Processing first ${imagesToProcess.length} pages as images for high precision.
                
                CRITICAL INSTRUCTION:
                You MUST iterate through ALL provided images.
                You MUST extract cabinets from EACH page. 
                
                REQUIRED SCRATCHPAD FORMAT:
                You must start your scratchpad with:
                "Analyzing Page 1..."
                [findings for page 1]
                "Analyzing Page 2..."
                [findings for page 2]
                ...and so on.
                ***` });

                // Add each page as a separate image part
                imagesToProcess.forEach(img => {
                    contentsParts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.data
                        }
                    });
                    // Add a text separator to help AI distinguish pages
                    contentsParts.push({ text: `[--- IMAGE FOR PAGE ${img.pageNumber} ---]` });
                });
                
                if (pdfImages.length > MAX_IMAGES) {
                     contentsParts.push({ text: `[--- WARNING: DOCUMENT TRUNCATED AT PAGE ${MAX_IMAGES}. USER HAS MORE PAGES BUT SYSTEM LIMIT REACHED ---]` });
                }

            } catch (pdfErr) {
                console.error("PDF Rasterization failed. Falling back to raw PDF upload.", pdfErr);
                // Fallback: Upload raw PDF if rasterization fails
                // For PDFs, check size limit (Gemini Inline Data Limit is ~20MB safety margin)
                const MAX_PDF_SIZE = 19 * 1024 * 1024; // 19MB to be safe
                if (file.size > MAX_PDF_SIZE) {
                    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit is 19MB. Please compress the PDF or split it.`);
                }

                const base64Data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(cleanBase64(reader.result as string));
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                contentsParts.push({
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: base64Data
                    }
                });
            }
        }
    } else {
        // IMAGE HANDLING
        let base64Data: string;
        try {
            base64Data = await resizeImageIfNeeded(file);
        } catch (e) {
            console.warn("Image resize failed, falling back to raw file", e);
            base64Data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(cleanBase64(reader.result as string));
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }
        contentsParts.push({
            inlineData: {
                mimeType: mimeType,
                data: base64Data
            }
        });
    }

    // Add System Instruction at the end
    contentsParts.push({ text: SYSTEM_INSTRUCTION });

    try {
        const ai = getAI();
        
        // Log parts structure for debugging
        console.log(`Sending ${contentsParts.length} parts to Gemini AI...`);

        // Check if token limit is sufficient for 19 pages output
    const generationConfig = {
        temperature: 0.2, // Low temperature for factual extraction
        maxOutputTokens: 65536, // Maximize for multi-page output (Gemini 2.5 Flash supports huge context)
        responseMimeType: "application/json",
        responseSchema: {
            type: "OBJECT",
            properties: {
                scratchpad: { type: "STRING", description: "Raw list of all potential codes found, GROUPED BY PAGE NUMBER (e.g. 'Page 1:', 'Page 2:')" },
                specs: {
                        type: "OBJECT",
                        properties: {
                            manufacturer: { type: "STRING", description: "Manufacturer Name" },
                            doorStyle: { type: "STRING", description: "Door Style Name" },
                            finish: { type: "STRING", description: "Finish/Color Name" },
                            construction: { type: "STRING", description: "Construction specs" },
                            notes: { type: "STRING", description: "Project notes" }
                        }
                    },
                    items: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                code: { type: "STRING", description: "Exact Product Code (e.g. VDB27AH-3). IF TEXT IS MISSING, CONSTRUCT NKBA CODE (e.g. B15, W3030) FROM DIMS. NEVER RETURN 'UNKNOWN'." },
                                normalizedCode: { type: "STRING", description: "NKBA equivalent code" },
                                qty: { type: "NUMBER" },
                                type: { type: "STRING", description: "Base, Wall, Tall, Filler, Panel, Accessory" },
                                description: { type: "STRING" },
                                width: { type: "NUMBER" },
                                height: { type: "NUMBER" },
                                depth: { type: "NUMBER" },
                                extractedPrice: { type: "NUMBER" },
                                modifications: {
                                    type: "ARRAY",
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            description: { type: "STRING" },
                                            price: { type: "NUMBER" }
                                        }
                                    }
                                },
                                notes: { type: "STRING" }
                            },
                            required: ["code", "qty", "type", "description"]
                        }
                    }
                },
                required: ["items", "specs"]
            }
        };

        const response = await callAIWithRetry(async () => {
            const result = await ai.models.generateContent({
                model: MODEL_NAME,
                contents: { parts: contentsParts },
                config: generationConfig
            });
            return result;
        });

        let text = "";
        try {
            // Handle different SDK versions (method vs getter)
            const r = response as any;
            if (typeof r.text === 'function') {
                text = r.text();
            } else if (typeof r.text === 'string') {
                text = r.text;
            } else if (r.response && typeof r.response.text === 'function') {
                text = r.response.text();
            } else {
                text = JSON.stringify(r); // Fallback debug
            }
        } catch (e) {
            console.error("Error extracting text from AI response:", e);
        }

        console.log("AI Raw Response Length:", text.length);
        console.log("AI Raw Response Preview:", text.substring(0, 500));

        const result = safeJSONParse(text);

        if (result.scratchpad) {
            console.log("--- AI SCRATCHPAD CONTENT ---");
            console.log(result.scratchpad);
            console.log("-----------------------------");
        }
        const rawItems = Array.isArray(result?.items) ? result.items : [];
        const rawSpecs = result?.specs || {};

        const items = rawItems.filter((item: any) => {
            // Post-Processing Filter: Remove obvious appliances/garbage if AI failed
            const desc = (item.description || "").toUpperCase();
            const code = (item.code || "").toUpperCase();

            // Helper: Is this likely a valid cabinet code? (e.g. starts with B, W, T, S, P, V)
            // If code is "REF36", it's valid. If code is "FRIDGE", it's invalid.
            const isCabinetCode = /^[A-Z0-9]{2,}/.test(code) && 
                                  !["FRIDGE", "DISHWASHER", "RANGE", "OVEN", "MICROWAVE", "SINK", "FAUCET", "PAGE"].some(bad => code.includes(bad));
            
            // STRICTER APPLIANCE FILTERING
            // Exclude items that are JUST appliances, but keep cabinets/panels FOR appliances
            // ONLY filter if the CODE is also not a valid cabinet code
            
            // NOTE: If description is "Cabinet", we KEEP IT regardless of code.
            const isCabinetDescription = desc.includes("CABINET") || desc.includes("BASE") || desc.includes("WALL") || desc.includes("TALL") || desc.includes("VANITY") || desc.includes("DRAWER");
            
            if (desc.includes("FRIDGE") || desc.includes("REFRIGERATOR")) {
                 if (!desc.includes("PANEL") && !desc.includes("ENCLOSURE") && !desc.includes("KIT") && !isCabinetCode && !isCabinetDescription) return false;
            }
            if (desc.includes("DISHWASHER")) {
                 if (!desc.includes("PANEL") && !desc.includes("RETURN") && !desc.includes("KIT") && !isCabinetCode && !isCabinetDescription) return false;
            }
            if (desc.includes("RANGE") || desc.includes("COOKTOP") || desc.includes("OVEN")) {
                 if (!desc.includes("HOOD") && !desc.includes("KIT") && !isCabinetCode && !isCabinetDescription) return false;
            }
            // Exclude Sinks but keep Sink Bases and Accessories
            if (desc.includes("SINK")) {
                 if (!desc.includes("FRONT") && !desc.includes("TRAY") && !desc.includes("MAT") && !desc.includes("KIT") && !isCabinetCode && !isCabinetDescription) return false;
            }
            // Exclude Faucets
            if (desc.includes("FAUCET")) return false;

            // Exclude Microwaves but keep Cabinets
            if (desc.includes("MICROWAVE")) {
                if (!desc.includes("SHELF") && !desc.includes("KIT") && !desc.includes("HOOD") && !isCabinetCode && !isCabinetDescription) return false;
            }
            
            // Allow Trash/Recycle explicitly (override other filters if needed, though they shouldn't conflict)
            if (desc.includes("TRASH") || desc.includes("WASTE") || desc.includes("RECYCLE") || desc.includes("BIN")) return true;

            // Allow Interior Accessories explicitly (Expanded List)
            if (desc.includes("TRAY") || desc.includes("DIVIDER") || desc.includes("SPICE") || desc.includes("KNIFE") || desc.includes("CUTLERY") || desc.includes("ORGANIZER") || desc.includes("ROT") || desc.includes("SHELF") || desc.includes("INTERIOR") || desc.includes("DRAWER") || desc.includes("BUTT") || desc.includes("TD") || desc.includes("PULL OUT") || desc.includes("HAMPER") || desc.includes("RACK") || desc.includes("LAZY") || desc.includes("SUSAN") || desc.includes("CORNER") || desc.includes("BLIND") || desc.includes("LEMANS") || desc.includes("MAGIC")) return true;
            
            // Exclude Generic Electronics/Hardware (Expanded List)
            if (desc.includes("TELEVISION") || desc.includes(" TV ") || desc.includes("OUTLET") || desc.includes("SWITCH") || desc.includes("DATA") || desc.includes("PHONE") || desc.includes("CABLE") || desc.includes("SPEAKER") || desc.includes("AUDIO") || desc.includes("WIRE")) return false;
            
            // Exclude Plumbing Accessories (Expanded List)
            if (desc.includes("SOAP") || desc.includes("DISPENSER") || desc.includes("DRAIN") || desc.includes("STRAINER") || desc.includes("DISPOSAL") || desc.includes("AIR GAP") || desc.includes("FLANGE")) return false;
            
            if (code === "PAGE" || code.startsWith("PAGE ")) return false;
            
            return true;
        }).map((item: any, index: number) => {
            let type: CabinetType = 'Base'; 
            
            // Map AI type string to valid CabinetType
            const rawType = (item.type || '').toString().toLowerCase();
            const code = (item.code || "").toUpperCase();
            
            if (rawType.includes('wall')) type = 'Wall';
            else if (rawType.includes('tall') || rawType.includes('pantry') || code.startsWith('U') || code.startsWith('T')) type = 'Tall';
            else if (rawType.includes('filler')) type = 'Filler';
            else if (rawType.includes('panel') || rawType.includes('skin')) type = 'Panel';
            else if (rawType.includes('accessory') || rawType.includes('molding') || rawType.includes('kit') || rawType.includes('toe')) type = 'Accessory';
            else type = 'Base'; // Default

            // Defaults logic moved up for fallback usage
            let width = typeof item.width === 'number' ? item.width : 0;
            let height = typeof item.height === 'number' ? item.height : 0;
            let depth = typeof item.depth === 'number' ? item.depth : 0;

            // Cleanup Code
            let originalCode = item.code;
            
            // Fallback: If AI returns UNKNOWN or null, try to construct code from dimensions
            if (!originalCode || originalCode.toUpperCase() === 'UNKNOWN') {
                if (width > 0) {
                     // Refined Type Checking for Fallback
                     const desc = (item.description || "").toLowerCase();
                     const isDrawer = rawType.includes('drawer') || desc.includes('drawer');
                     const isSink = rawType.includes('sink') || desc.includes('sink');

                     if (type === 'Base') {
                         if (isDrawer) originalCode = `DB${width}`;
                         else if (isSink) originalCode = `SB${width}`;
                         else originalCode = `B${width}`;
                     }
                     else if (type === 'Wall') originalCode = `W${width}${height > 0 ? height : 30}`;
                     else if (type === 'Tall') originalCode = `U${width}${height > 0 ? height : 84}`;
                } else {
                    originalCode = "UNKNOWN";
                }
            }

            let normalizedCode = item.normalizedCode || originalCode;
            normalizedCode = normalizeNKBACode(normalizedCode);
            
            // Extract from NKBA code if 0 (e.g. W3030 -> 30W 30H)
            if (width === 0 && normalizedCode.match(/[A-Z]+(\d{2,})/)) {
                 const nums = normalizedCode.match(/(\d+)/)?.[0];
                 if (nums) {
                     if (nums.length >= 2) width = parseInt(nums.substring(0, 2));
                     if (nums.length >= 4 && type === 'Wall') height = parseInt(nums.substring(2, 4));
                 }
            }

            // Defaults
            if (height === 0) {
                if (type === 'Base') height = 34.5;
                if (type === 'Wall') height = 30;
                if (type === 'Tall') height = 84;
            }

            return {
                id: `extracted-${index}-${Date.now()}`,
                originalCode: originalCode,
                normalizedCode: normalizedCode,
                type: type,
                description: item.description || `Item ${index + 1}`,
                width: width,
                height: height,
                depth: depth,
                quantity: typeof item.qty === 'number' ? item.qty : 1,
                notes: item.notes || "",
                extractedPrice: item.extractedPrice || undefined,
                modifications: Array.isArray(item.modifications) ? item.modifications : []
            };
        });

        const constructionNote = rawSpecs.construction ? ` [Construction: ${rawSpecs.construction}]` : "";

        return {
            specs: {
                manufacturer: rawSpecs.manufacturer || "",
                wallDoorStyle: rawSpecs.doorStyle || "",
                baseDoorStyle: rawSpecs.doorStyle || "", 
                finishColor: rawSpecs.finish || "",
                notes: (rawSpecs.notes || "") + constructionNote,
                selectedOptions: {}
            },
            items: consolidateItems(items)
        };
    } catch (error: any) {
        console.error("AI Generation Error Full:", JSON.stringify(error, null, 2));
        throw new Error(`AI Analysis Failed: ${error.message}`);
    }
}

// NEW: AI-Powered Excel Structure Analysis
export async function determineExcelStructure(sheetName: string, sampleRows: any[][]): Promise<{ 
    skuColumn: number | null, 
    priceColumns: { index: number, name: string }[],
    optionTableType?: 'Stain' | 'Paint' | null,
    doorStyleName?: string | null // NEW: Detect Door Style name from sheet
}> {
    const ai = getAI();
    const dataStr = sampleRows.map((row, i) => `Row ${i}: ${row.slice(0, 15).map(c => String(c).substring(0,20)).join(' | ')}`).join('\n');

    const prompt = `
    Analyze this spreadsheet sample (Sheet: "${sheetName}").
    
    TASK 1: CATALOGUE
    Identify the Column Index (0-based) for "SKU" (Product Code) and Column Indices for "Price".
    NOTE: Unstructured data handling:
    - SKUs look like "W3030", "B15", "LS36", "TK8", "VDB27AH-3". They contain letters and numbers.
    - Prices are numeric (e.g., 450, 1200.50).
    - If there are multiple price columns (e.g. "Oak", "Maple", "Paint Grade"), list ALL of them with their names.
    - If headers are messy, deduce columns by the CONTENT pattern in the rows.
    
    TASK 2: PRINTED END OPTIONS (Specific)
    Does this sheet contain a table listing "Stain" or "Paint" options with a "Yes"/"No" column?
    Look for headers like "STAIN", "PAINT", "PAINT GRADE".
    If found, set optionTableType.

    TASK 3: DOOR STYLE DEFINITION
    Does this sheet define a specific Door Style? 
    Look for a header cell containing text like "ASHLAND DOOR STYLE" or "HIGHLAND DOOR STYLE" or "LIBERTY DOOR STYLE".
    If found, extract the pure style name (e.g. "Ashland", "Highland", "Nova", "Liberty").
    Ignore generic headers like "DOOR STYLES".
    **CRITICAL FALLBACK**: If the sheet name itself is NOT a generic section (like "Base", "Wall", "Summary") and headers are missing, assume the Sheet Name IS the Door Style Name (e.g. Sheet "Ashland" -> Style "Ashland").
    
    Return JSON:
    {
       "skuColumn": number | null,
       "priceColumns": [ { "index": number, "name": "string" } ],
       "optionTableType": "Stain" | "Paint" | null,
       "doorStyleName": string | null
    }
    `;

    try {
        const response = await callAIWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_NAME, // Use the default Flash model
                contents: { parts: [{ text: prompt }, { text: dataStr }] },
                config: { 
                    responseMimeType: "application/json",
                    temperature: 0.0 // Deterministic
                }
            });
        });
        
        const result = safeJSONParse(response.text || "{}");
        return {
            skuColumn: result.skuColumn ?? null,
            priceColumns: Array.isArray(result.priceColumns) ? result.priceColumns : [],
            optionTableType: result.optionTableType || null,
            doorStyleName: result.doorStyleName || null
        };
    } catch (e) {
        console.error("Structure Analysis Failed", e);
        return { skuColumn: null, priceColumns: [], optionTableType: null, doorStyleName: null };
    }
}
