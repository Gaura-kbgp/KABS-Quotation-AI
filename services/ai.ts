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
2.  **Room Detection (CRITICAL)**: 
    - Identify which Room/Area each item belongs to (e.g., "Kitchen", "Master Bath").
    - If multiple Kitchens exist, number them: "Kitchen 1", "Kitchen 2".
    - If multiple Bathrooms exist, number them: "Bath 1", "Bath 2".
    - Assign the "room" field for EVERY item. Default to "General" if unknown.
3.  **Find Codes**: Identify cabinet codes (e.g., "B30", "W3030", "VDB27", "SB36").
4.  **Infer Missing Codes**: If a cabinet has dimensions but no code (e.g., a 30" wide Base), construct the code "B30". Use "W{width}{height}" for walls.
5.  **Filter Noise**: Exclude appliances (Fridge, Stove, DW) unless they are cabinet enclosures/panels. Exclude electrical/plumbing symbols.
6.  **Grouping**: Group findings by page in the "scratchpad" field.
7.  **Deduplicate**: If the SAME cabinet appears multiple times (e.g. Plan vs Elevation), count it ONLY ONCE.
8.  **Text Mode**: If analyzing raw text, assume it is a Cabinet List/Quote. Extract the codes and quantities directly.

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
        const room = item.room || "General";
        
        // Key includes type to differentiate Base vs Wall if codes are ambiguous
        // ADDED ROOM TO KEY to prevent merging items across rooms!
        const key = `${normCode}_${item.type}_${w}x${h}x${d}_${mods}_${room}`;

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

interface RoomContext {
    currentRoom: string;
    counts: { [key: string]: number };
    lastKitchenRoom: string | null;
    lastBathRoom: string | null;
}

function tryLocalRegexExtraction(text: string): CabinetItem[] {
    const items: CabinetItem[] = [];
    
    // Context to track rooms across pages/chunks
    const context: RoomContext = {
        currentRoom: "Kitchen 1", // Default to Kitchen 1 instead of General
        counts: { kitchen: 1, bath: 0 }, // Start with 1 kitchen
        lastKitchenRoom: "Kitchen 1",
        lastBathRoom: null
    };
    
    // Updated Regex to allow:
    // 1. Standard Code: B30, W3030
    // 2. Space + Suffix: SB33 BUTT, W3030 L
    // 3. Modifiers: BUTT, L, R, 2B, etc.
    // It captures: [CodePart] (Space [SuffixPart])*
    // We limit suffixes to uppercase letters/digits/dashes to avoid capturing descriptions.
    // Broader regex to catch more valid codes
    // const codeRegex = /\b([A-Z]{1,4}\d{2,}(?:[ -][A-Z0-9]+)*)\b/g; // Unused here, defined in extractFromChunk
    
    // Split by page markers first to assign rooms
    // extractTextFromPdf adds "\n--- PAGE X ---\n"
    // Use case-insensitive split and handle potential extra whitespace
    const pages = text.split(/--- PAGE (\d+) ---/i);
    
    // pages[0] is usually empty or pre-text. 
    // Then we get [pageNum, pageContent, pageNum, pageContent...]
    
    let currentPageNum = "1";
    
    console.log(`Local Regex Extraction: Found ${Math.floor(pages.length / 2)} pages of text.`);

    // If text was split by page markers, iterate through pages
    if (pages.length > 1) {
        for (let i = 1; i < pages.length; i += 2) {
             currentPageNum = pages[i];
             const pageContent = pages[i+1];
             if (!pageContent) {
                 console.warn(`Page ${currentPageNum} has empty content.`);
                 continue;
             }
             
             // console.log(`Processing Page ${currentPageNum}...`);
             extractFromChunk(pageContent, items, currentPageNum, context);
        }
    } else {
        // Fallback for single chunk
        extractFromChunk(text, items, "1", context);
    }
    
    return items;
}

function extractFromChunk(chunk: string, items: CabinetItem[], pageNum: string, context: RoomContext) {
    // UPDATED REGEX:
    // 1. Letters (A-Z): 1-5 chars (e.g. B, VSB, TOUCH)
    // 2. Digits: 1 or more (e.g. 8 in BTK8, 30 in B30)
    // 3. Optional attached suffix: Letters only (e.g. H in VSB3634H, L in B30L)
    // 4. Separator + Suffixes: Space or dash, followed by alphanumeric (e.g. " BUTT", " 2B", " 2X4X96")
    const codeRegex = /\b([A-Z]{1,5}\d{1,}[A-Z]*(?:[\s-][A-Z0-9\/]+)*)\b/g;

    const lines = chunk.split('\n');
    
    for (const line of lines) {
        if (line.length < 4) continue;
        if (line.includes('Page') && line.includes('of')) continue;
        
        // --- Room Detection Logic ---
        // Heuristic: Short line, contains Room Keyword, NO codes, NO ignored words
        const lower = line.toLowerCase();
        
        // Allow "Standard" and "Opt" (Optional) to be part of headers
        const isExplicitHeader = /^(standard|opt|optional)\b/i.test(line);

        // Check for Room Header BEFORE checking for codes
        // Some PDFs have "Kitchen: B30" on same line.
        // But headers like "Standard 42 Kitchen" should be caught.

        // Stricter Length Limit for Headers (was 60)
        let potentialHeader = line;
        let isSameLineHeader = false;
        
        const hasCode = codeRegex.test(line);
        if (hasCode) {
            // Check if the line STARTS with a room name followed by a colon or space
            // Added support for "Kitchen 1", "Kitchen 2", "Unit 1 Kitchen" patterns
            const match = line.match(/^((?:Unit\s+\d+|Standard|Opt|Optional|Kitchen|Bath|Master|Utility|Laundry|Room|Area|Owners|Powder|Ensuite)[^:]*?)(?::|\s{2,}|(?=\s[A-Z0-9]))/i);
            if (match) {
                potentialHeader = match[1];
                if (potentialHeader.length < 60) { 
                     isSameLineHeader = true;
                }
            }
        }

        if ((!hasCode || isSameLineHeader) && potentialHeader.length < 60) {
            
            // 1. Explicit "Room:" prefix support
            const roomPrefixMatch = potentialHeader.match(/^(?:room|area|location|phase|unit)\s*[:\-#]?\s*(.+)/i);
            if (roomPrefixMatch) {
                let rName = roomPrefixMatch[1].trim();
                // Clean up weird chars
                rName = rName.replace(/[:\-]/g, '').trim();
                if (rName.length > 2 && rName.length < 40) {
                    context.currentRoom = rName; // Trust explicit headers
                    // Reset kitchen context if we switch to an explicit room that might be a kitchen
                    if (/kitchen/i.test(rName)) {
                         // Try to extract number
                         const num = rName.match(/kitchen\s*(\d+)/i);
                         if (num) {
                             context.counts.kitchen = parseInt(num[1]);
                             context.lastKitchenRoom = rName;
                         } else {
                             // If it's just "Kitchen" and we already had one, maybe it's a new one?
                             // But often it's just a header repetition. Keep current count if valid.
                             if (!context.lastKitchenRoom) {
                                 context.counts.kitchen = 1;
                                 context.lastKitchenRoom = "Kitchen 1";
                                 context.currentRoom = "Kitchen 1";
                             } else {
                                 // If the header is exactly "Kitchen", stick to last known.
                                 // If it's "Kitchen 2", we would have caught it above if explicit.
                                 context.currentRoom = context.lastKitchenRoom; 
                             }
                         }
                    } else {
                        context.lastKitchenRoom = null; // Left the kitchen area
                    }
                    if (!isSameLineHeader) continue;
                }
            }

            // 2. Keyword Search with Word Boundaries (\b) to avoid partial matches
            const lowerHeader = potentialHeader.toLowerCase();
            const isKitchen = /\bkitchen\b/i.test(potentialHeader);
            const isBath = /\b(bath|bathroom|vanity|ensuite|powder|restroom|owners)\b/i.test(potentialHeader);
            // STRICT MODE: Laundry should be separate as per user request
            const isLaundry = /\b(laundry|utility|mud)\b/i.test(potentialHeader);
            const isIsland = false; // Island usually implies Kitchen, so we handle it by defaulting to current kitchen or ignored
            const isOther = false; 
            
            // Words that suggest this is NOT a header but a description
            const ignoredWords = [
                'cabinet', 'base', 'wall', 'tall', 'filler', 'molding', 'toe', 'kick', 
                'panel', 'door', 'drawer', 'hinge', 'slide', 'accessory', 'hardware', 
                'touch', 'kit', 'install', 'glaze', 'paint', 'stain', 'finish', 
                'upgrade', 'style', 'color', 'spec', 'note', 'adjacent', 
                'chute', 'basket', 'hamper', 'sink', 'faucet', 'counter', 'top',
                'description', 'qty', 'code', 'price', 'total', 'page'
            ];
            
            // Special Check: "Perimeter" usually implies we are inside a Kitchen, not a new room.
            const isPerimeter = /\bperimeter\b/i.test(potentialHeader);
            
            let hasIgnored = ignoredWords.some(w => lowerHeader.includes(w));
            
            // If it starts with "Standard" or "Opt", we might be stricter about what we ignore
            if (isExplicitHeader) {
                hasIgnored = false; 
            }

            if ((isKitchen || isBath || isLaundry || isIsland || isOther || isPerimeter) && !hasIgnored) {
                // Ensure it's not just a random word in a sentence
                const wordCount = potentialHeader.split(/\s+/).length;
                if (wordCount > 8 && !isExplicitHeader) { 
                    if (!isSameLineHeader) continue;
                } 

                // --- SMART NAME EXTRACTION ---
                let detectedName = potentialHeader.trim();
                
                // 1. STRONG MATCH EXTRACTION
                // Instead of trying to clean garbage, extract ONLY what we know is a room name.
                // This fixes "MIH 4031 MAGNOLIA STD OWNERS BATH GR 1951" -> "OWNERS BATH"
                // REMOVED "Pantry", "Island", "Dining", "Living", "Bed", "Bar", "WIC" from regex
                // ONLY allow Kitchen, Bath, Laundry variations.
                // UPDATED: Allow intervening words (like "42" or "GMT") between prefix and room type to distinguish "Standard 42 Kitchen" vs "Opt GMT Kitchen"
                const strongRoomRegex = /\b((?:(?:Standard|Opt|Optional|Upgrade|Master|Guest|Owners|Ensuite|Powder|Main|Upper|Lower|Bsmt|Basement|Gourmet)(?:\s+[\w\d\-\.]+){0,3}\s+)?(?:Kitchen|Bath(?:room)?|Vanity|Laundry|Utility))\b(?:\s*(\d+))?/i;
                
                const strongMatch = detectedName.match(strongRoomRegex);
                
                if (strongMatch) {
                    // Reconstruct from match parts: [FullMatch, NamePrefix+Name, Number]
                    let coreName = strongMatch[1].trim();
                    const num = strongMatch[2];
                    
                    // Clean up core name casing
                    coreName = coreName.replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase())));
                    
                    if (num) {
                        detectedName = `${coreName} ${num}`;
                    } else {
                        detectedName = coreName;
                    }
                } else {
                    // Fallback to cleanup logic if no strong keyword found (less likely now due to checks above)
                    detectedName = detectedName.replace(/[:\-]+$/, '').trim();
                    detectedName = detectedName.replace(/^\d+[\.\)]\s*/, '');
                    detectedName = detectedName.replace(/^(OPT|OPTIONAL|STANDARD|UPGRADE)\s+/i, '');
                    detectedName = detectedName.replace(/\s+(UPPERS|LOWERS|CABINETS|TOPS|BASES|WALLS|VANITIES|OVER|ACROSS|FROM|W\/D|WASHER|DRYER).*$/i, '');
                    detectedName = detectedName.replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase())));
                }

                // Detect Number in Header (e.g. "Kitchen 2", "Bath 3")
                const explicitNumberMatch = detectedName.match(/(?:Kitchen|Bath|Bathroom|Room)\s*(\d+)/i);
                
                if (isPerimeter) {
                    if (context.lastKitchenRoom) {
                         context.currentRoom = context.lastKitchenRoom;
                    }
                    // Perimeter is part of kitchen, so don't clear lastBathRoom if we are bouncing between kitchen parts?
                    // Usually Perimeter implies Kitchen.
                    context.lastBathRoom = null; 
                } else if (isKitchen) {
                    if (explicitNumberMatch) {
                         // Explicit "Kitchen 2"
                         const num = parseInt(explicitNumberMatch[1]);
                         context.counts.kitchen = num;
                         context.currentRoom = detectedName; // e.g. "Kitchen 2"
                         context.lastKitchenRoom = detectedName;
                    } else if (detectedName.toLowerCase() === "kitchen") {
                         // Just "Kitchen"
                         if (!context.lastKitchenRoom) {
                             context.counts.kitchen = 1;
                             context.lastKitchenRoom = "Kitchen 1";
                         }
                         context.currentRoom = context.lastKitchenRoom || "Kitchen 1";
                    } else {
                         // Something like "Standard Kitchen" or "Gourmet Kitchen" or "Standard 42 Kitchen"
                         // Check if this new name is significantly different from the last one to warrant a new room
                         // or if it's just a variation we should treat as a new room.
                         // For safety, if it's not "Kitchen", assume it's a specific room name.
                         context.currentRoom = detectedName;
                         context.lastKitchenRoom = detectedName;
                    }
                    context.lastBathRoom = null; // Left bath
                } else if (isIsland) {
                    if (context.lastKitchenRoom) {
                        context.currentRoom = context.lastKitchenRoom;
                    } else {
                        context.counts.kitchen = 1;
                        context.currentRoom = "Kitchen 1";
                        context.lastKitchenRoom = "Kitchen 1";
                    }
                    context.lastBathRoom = null;
                } else if (isBath) {
                    if (explicitNumberMatch) {
                         context.currentRoom = detectedName;
                         context.lastBathRoom = detectedName;
                    } else if (detectedName.length > "Bath".length + 4) {
                         // Specific name like "Master Bath"
                         context.currentRoom = detectedName;
                         context.lastBathRoom = detectedName;
                    } else {
                         // Generic "Bath" or "Bathroom"
                         if (context.lastBathRoom) {
                             // Continuation of previous bath
                             context.currentRoom = context.lastBathRoom;
                         } else {
                             // New generic bath
                             context.counts.bath++;
                             context.currentRoom = `Bath ${context.counts.bath}`;
                             context.lastBathRoom = context.currentRoom;
                         }
                    }
                    context.lastKitchenRoom = null; // Left kitchen
                } else if (isLaundry) {
                     context.currentRoom = detectedName.length > 3 ? detectedName : "Laundry";
                     context.lastKitchenRoom = null;
                     context.lastBathRoom = null;
                } else {
                    if (detectedName.length > 30) detectedName = "Other Room";
                    context.currentRoom = detectedName;
                    context.lastKitchenRoom = null;
                    context.lastBathRoom = null;
                }
                
                if (!isSameLineHeader) continue; 
            }
        }
        
        const matches = [...line.matchAll(codeRegex)];
        if (matches.length === 0) continue;
        
        // Find quantity
        let qty = 1;
        // Updated Quantity Regex to handle "1-BTK8", "1 - BTK8", "3 BTK8", "3- BTK8"
        // Look for digit(s) at start of line, optionally followed by dash/space
        const qtyMatch = line.match(/^(\d+)\s*[-\s]\s*/); 
        if (qtyMatch) {
            qty = parseInt(qtyMatch[1], 10);
            if (qty > 100 || qty < 1) qty = 1; 
        }
        
        for (const match of matches) {
            const code = match[1];
            if (code.match(/^\d{4}/)) continue; // Year like 2024
            if (code.length > 30) continue; // Safety limit
            if (code.includes("PHONE") || code.includes("FAX")) continue;
            if (["PAGE", "ITEM", "NOTE", "DATE", "TIME", "TOTAL", "SUBTOTAL", "QTY", "PRICE", "AMOUNT"].includes(code)) continue;
            // Filter out explicit appliance codes/descriptions that might be picked up
            if (/^(DISHWASHER|MICROWAVE|OVEN|FRIDGE|REFRIGERATOR|RANGE|HOOD|COOKTOP|WASHER|DRYER|APPLIANCE)/i.test(code)) continue;

            // Basic Type Inference
            let type: CabinetType = 'Base';
            if (code.startsWith('W')) type = 'Wall';
            else if (code.startsWith('T') || code.startsWith('U') || code.startsWith('O')) type = 'Tall';
            else if (code.startsWith('V') || code.startsWith('B') && code.includes('VAN')) type = 'Accessory'; // Vanities?
            else if (code.startsWith('D') && !code.startsWith('DB')) type = 'Accessory'; // Drawer fronts?
            
            // --- EXTRACT DESCRIPTION ---
            // Get text AFTER the code match on the same line
            // match.index is where code starts. match[0].length is code length.
            let description = "";
            if (match.index !== undefined) {
                const afterCode = line.substring(match.index + match[0].length).trim();
                if (afterCode.length > 2) {
                    description = afterCode;
                    // Remove Price at end (e.g. $1,234.00 or 1,234.00)
                    description = description.replace(/[\$]?[\d,]+\.\d{2}$/, '').trim();
                    // Remove leading hyphens/separators
                    description = description.replace(/^[-–—]\s*/, '').trim();
                }
            }
            
            // If still empty or just garbage, generate a smart description based on code
            if (!description || description.length < 3) {
                if (type === 'Base') description = `Base Cabinet ${code.match(/\d+/)?.[0] || ""}"`;
                else if (type === 'Wall') description = `Wall Cabinet ${code.match(/\d+/)?.[0] || ""}"`;
                else if (type === 'Tall') description = `Tall Cabinet ${code.match(/\d+/)?.[0] || ""}"`;
                else if (type === 'Accessory') description = `Accessory/Part ${code}`;
                else description = "Cabinet Item";
            }

            // If we have a code but NO room context yet, default to Kitchen 1.
            // This prevents "General" bucket for the first set of items if header is missed or implicit.
            if (!context.currentRoom) {
                context.currentRoom = "Kitchen 1";
                context.counts.kitchen = 1;
                context.lastKitchenRoom = "Kitchen 1";
            }

            items.push({
                id: `local_${Date.now()}_${items.length}_${Math.random().toString(36).substr(2,5)}`,
                originalCode: code,
                quantity: qty,
                type: type,
                description: description, 
                width: 0, height: 0, depth: 0,
                normalizedCode: code,
                room: context.currentRoom // Use the detected room
            });
        }
    }
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
 From the specification guide (especially Table of Contents or Index pages), identify and group: 
 
 1. Door Style (Hierarchy: Collection/Series -> Door Style)
    - Look for Collections (e.g. "Elite", "Premium", "Classic").
    - "Elite" data is High Priority if present.
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
 • Check the Table of Contents/Index first to find Collection names.
 • If "Elite" collection exists, make sure to extract its specific options.
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
       "section": "Collection", 
       "type": "select", 
       "options": ["Elite", "Premium", "Standard"] 
     },
     { 
       "section": "Door Style", 
       "type": "dependent-select", 
       "dependsOn": "Collection",
       "options": [ 
         { 
           "collection": "Elite", 
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
             // LOWERED THRESHOLD: If we find even ONE valid item via regex, trust it and return immediately.
             // This is the "Fast Scan" promise.
             if (localItems.length >= 1) {
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

                // OPTIMIZATION: If too many pages (>50), fallback to text-only mode for the remaining pages or warn user
                // User requested FULL SCAN of large docs, so we increased limit from 15 to 50.
                const MAX_IMAGES = 50;
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
                                room: { type: "STRING", description: "The room/area this item belongs to (e.g. Kitchen 1, Bath 2, Laundry)" },
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
                room: item.room || "General",
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
