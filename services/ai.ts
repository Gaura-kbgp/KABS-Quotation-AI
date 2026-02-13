import { GoogleGenAI } from "@google/genai";
import { CabinetItem, ProjectSpecs, CabinetType } from "../types";
import { normalizeNKBACode } from "./pricingEngine";

// Using import.meta.env.VITE_GEMINI_API_KEY as per guidelines
const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

// Updated to Flash 1.5 for maximum speed (Sub-10s extraction)
// PRIORITY: User requested 2.5/3, but since those are not public, we use 2.0 Flash/Pro experimental and fallbacks.
const MODEL_PRIORITY = [
    'gemini-3-pro-preview', // User requested top priority
    'gemini-2.5-pro',       // User requested
    'gemini-2.5-flash',     // User requested
    'gemini-2.0-flash-exp', // Newest real fast model
    'gemini-1.5-pro',       // High quality fallback
    'gemini-1.5-flash',     // Standard fast model
    'gemini-1.0-pro'        // Legacy fallback
];

// Helper to iterate through models if one fails (e.g. 404 Not Found)
async function generateWithFallback(ai: any, contents: any, config: any) {
    let lastError;
    for (const model of MODEL_PRIORITY) {
        try {
            console.log(`Attempting AI generation with model: ${model}`);
            const result = await ai.models.generateContent({
                model: model,
                contents: contents,
                config: config
            });
            console.log(`Success with model: ${model}`);
            return result;
        } catch (error: any) {
            console.warn(`Model ${model} failed:`, error.message || error);
            lastError = error;
            // specific error handling: if it's a safety block, maybe don't retry? 
            // But for 404/503 we definitely retry next model.
        }
    }
    throw lastError; // All models failed
} 

const SYSTEM_INSTRUCTION = `
You are Design AI, an expert kitchen cabinet estimator.

GOAL: Extract EVERY cabinet code from the provided document (PDF or Images) with 100% ACCURACY.
INPUT: Either extracted text from a PDF OR a sequence of images.
OUTPUT: A JSON object with "scratchpad", "specs", and "items".
- "items": Array of { originalCode, type, quantity, room, sourcePage, description, width, height, depth }
- "sourcePage": The page number where the item was found (e.g., 1, 2, 5). CRITICAL for sorting.

### **CRITICAL: EXCLUSION RULES (WHAT TO IGNORE)**
❌ **DO NOT EXTRACT**:
- **Appliances**: CKT30 (Cooktop), Dishwashers, Ranges, Microwaves, Fridges.
- **Plumbing**: WTDP, Sinks, Faucets.
- **Ventilation**: Vent box, Hood Liners, Power Packs.
- **Optional Items**: Any item explicitly marked as "Optional" or "Alt" unless it is part of a valid room variant (e.g., "Opt Gourmet Kitchen").
- **Left-Side Design Descriptions**: Ignore long paragraphs of design notes, architectural descriptions, or general notes on the left/side margins. Focus ONLY on the Floor Plan labels and Cabinet Schedules.
- **Random Codes**: Do not extract random numbers, electrical symbols, or dimension lines.
- **NON-KITCHEN/BATH AREAS (STRICT)**:
  - **IGNORE ENTIRELY**: "Laundry", "Utility", "Mudroom", "Garage", "Pantry", "Living Room", "Dining Room".
  - **EVEN IF THEY HAVE CABINETS**: Do NOT extract them. The user wants **ONLY KITCHENS AND BATHROOMS**.
  - **Example**: If you see "OPT LAUNDRY" with "W3030", **IGNORE IT**.
  - **Exception**: Only extract if the header explicitly says "KITCHEN" (e.g. "BUTLER'S PANTRY KITCHEN") or "BATH".

### **CRITICAL: COUNTING ACCURACY**
- **COUNT EVERY INSTANCE**: If you see 4 identical cabinets in the drawing, you MUST extract 4.
- **VISUAL VERIFICATION**: Look at the Floor Plan. If there are 4 boxes drawn for "B15" but the text label only appears once with "Qty: 4" ensure you extract quantity: 4.
- **MISMATCH FIX**: If the text says "Qty: 3" but you see 4 drawn boxes, TRUST THE DRAWING (4 boxes).
- **Cabinet 4 Issue**: Specifically check for cabinets that might be hidden in corners or islands. Don't miss the 4th cabinet!

### **CRITICAL: INCLUSION & CATEGORIZATION RULES**
✅ **EXTRACT & CATEGORIZE AS FOLLOWS**:

1. **Wall Cabinets** (Type: "Wall")
   - Codes starting with: W, DC, WDC, WBC.

2. **Base Cabinets** (Type: "Base")
   - Codes starting with: B, SB, DB, LS, BEC, BBC.

3. **Vanity Cabinets** (Type: "Vanity")
   - Codes starting with: **VSB** (Vanity Single Bowl), VDB.
   - **VSB** MUST be categorized as "Vanity", NOT "Base".

4. **Tall Cabinets** (Type: "Tall")
   - Codes starting with: T, U, O, P.
   - **Universal Pillars** MUST be categorized as "Tall".

5. **Fillers** (Type: "Filler")
   - Codes starting with: F, UF, WF, TF.
   - **Strictly separate** Fillers from Cabinets.

6. **Hardware** (Type: "Hardware")
   - **EXACT MATCH**: Extract hardware names/codes EXACTLY as written.
   - Includes: Handles, Knobs, Hinges, Legs, Rods.

7. **Finishing & Panels** (Type: "Finishing")
   - Includes: Skin, Panel, Molding, Valance, Corbel, Toe Kick (TK), Touch-up kits.

### **CRITICAL: ROOM GROUPING & MERGING**
- **ONE ROOM, MULTIPLE PAGES**: A single room (like "Kitchen") often spans multiple pages (Floor Plan, Elevations A, B, C).
- **MERGE THEM**: You MUST group all items from these related pages into **ONE single room entry**.
- **REUSE EXACT NAMES**: If Page 1 says "STANDARD 42\" KITCHEN" and Page 2 says "STANDARD KITCHEN PLAN", output "STANDARD 42\" KITCHEN" for BOTH. Do not create variations.
- **DO NOT** create separate rooms for "Kitchen Plan" and "Kitchen Elevation".
- **DO NOT** create separate rooms for "Page 1" and "Page 2" if they are the same room.
- **IDENTIFY THE HEADER**: Look for the **Specific Room Name** (e.g., "STANDARD 42\" KITCHEN" or "OPT GOURMET KITCHEN"). Use this EXACT name for ALL items in that section, regardless of the page view (Plan/Elevation).
- **IGNORE**: "Elevation", "Plan View", "Detail", "Section" in room names.
- **IGNORE**: "OPT LAUNDRY" headers if they are just notes on a page. Only extract if it is a DISTINCT room with a full layout. If it's just a text note "OPT LAUNDRY BASES...", ignore it as a room name.

### **CRITICAL: TITLE BLOCK PARSING (AVOID SPLIT ERRORS)**
- **WARNING**: Title blocks are often split across multiple lines.
- **Example**:
  Line 1: "MI HOMES SARASOTA 4031 MAGNOLIA"
  Line 2: "STANDARD 42\" KITCHEN"
  Line 3: "GARAGE RIGHT 1951"
- **ACTION**: This is **ONE ROOM** called "STANDARD 42\" KITCHEN".
  - "MI HOMES..." is Builder Info -> IGNORE.
  - "GARAGE RIGHT..." is Location Info -> IGNORE.
- **DO NOT** create a room called "GARAGE RIGHT".
- **DO NOT** create a room called "STANDARD 42\" KITCHEN GARAGE RIGHT".
- **ONLY** use the functional room name: "STANDARD 42\" KITCHEN".

### **CRITICAL: ROOM SEQUENCE & NAMING**
- **ORDER MATTERS**: You MUST process rooms in the **EXACT ORDER** they appear in the PDF pages.
- **NO REORDERING**: Do not group all "Kitchens" together.
- **TITLE BLOCK PRIORITY**: The Room Name is usually in the main Title Block (bottom/side of the page) or the largest text label.
  - **Preferred**: "STANDARD 42\" KITCHEN", "OPT GOURMET KITCHEN", "STANDARD OWNERS BATH".
  - **Avoid**: "Kitchen" (Too generic), "GARAGE RIGHT" (Not a room with cabinets), "MI HOMES" (Builder name).
  - Use the **Full Architectural Name** found on the page.

### **INTELLIGENCE RULES**:
1.  **Analyze All Input**: Read every page provided.
2.  **Room Detection**: Use Title Blocks or Room Labels. Assign the "room" field for EVERY item.
3.  **Code Reading**:
    - **TEXT PRIORITY**: Cabinet Schedules are the SOURCE OF TRUTH.
    - **VISUAL PRIORITY**: Floor Plans verify quantities.
    - **DEEP SCAN**: Scan walls clockwise.
    - **Every Label Matters**: Count every instance of a code.
4.  **Infer Missing Codes**: If a cabinet has dimensions but no code, construct one (e.g., "B30").

Your extraction must be exhaustive, accurate, and strictly follow the exclusion rules.
`;

// Helper: Merge rooms that are likely the same (e.g. "Kitchen" vs "Kitchen Plan")
function mergeSimilarRooms(items: CabinetItem[]): CabinetItem[] {
    // 1. Map all items to their current room names
    const roomMap = new Map<string, CabinetItem[]>();
    items.forEach(item => {
        const room = (item.room || "General").trim();
        if (!roomMap.has(room)) roomMap.set(room, []);
        roomMap.get(room)!.push(item);
    });

    const roomNames = Array.from(roomMap.keys());
    const mergeMap = new Map<string, string>(); // oldName -> newName

    // Helper to extract core identity of a room
    const getRoomIdentity = (name: string) => {
        const n = name.toUpperCase()
            .replace(/PLAN|ELEVATION|VIEW|DETAIL|SECTION|PAGE|LEVEL|FLOOR|LAYOUT|SCHEMATIC|DRAWING/g, '') // Remove view types
            .replace(/GARAGE\s*(RIGHT|LEFT)/g, '') // Remove location specific noise
            .replace(/[^A-Z0-9\s]/g, ' ') // Remove special chars
            .trim();
        
        const tokens = n.split(/\s+/).filter(t => t.length > 0);
        
        let type = "OTHER";
        if (tokens.some(t => /KITCHEN/i.test(t))) type = "KITCHEN";
        else if (tokens.some(t => /BATH|VANITY|ENSUITE|POWDER|RESTROOM/i.test(t))) type = "BATH";
        else if (tokens.some(t => /LAUNDRY|UTILITY/i.test(t))) type = "LAUNDRY";

        // Discriminators: Words that distinguish rooms of the same type
        // We KEEP numbers like 1, 2, 3 (Bath 2 vs Bath 3)
        // We KEEP adjectives like GOURMET, STANDARD, OWNERS, MASTER, GUEST
        const discriminators = new Set<string>();
        tokens.forEach(t => {
            if (['KITCHEN', 'BATH', 'BATHROOM', 'VANITY', 'ROOM', 'PLAN', 'ELEVATION'].includes(t)) return;
            // Ignore small numbers that might be part of dimensions (42) unless small (1, 2, 3)
            if (/^\d+$/.test(t)) {
                if (parseInt(t) < 10) discriminators.add(t); // Keep 1, 2, 3
            } else {
                discriminators.add(t);
            }
        });

        return { type, discriminators, originalName: name, cleanName: n };
    };

    // 2. Identify merge candidates using fuzzy logic
    for (let i = 0; i < roomNames.length; i++) {
        for (let j = i + 1; j < roomNames.length; j++) {
            const r1 = roomNames[i];
            const r2 = roomNames[j];
            
            const id1 = getRoomIdentity(r1);
            const id2 = getRoomIdentity(r2);

            // Must be same type to merge (Kitchen != Bath)
            if (id1.type !== id2.type) continue;
            if (id1.type === 'OTHER') continue; // Don't merge unknown types aggressively

            // Check discriminators
            const d1 = Array.from(id1.discriminators);
            const d2 = Array.from(id2.discriminators);
            
            const allDiscriminators = new Set([...d1, ...d2]);
            const intersection = d1.filter(x => id2.discriminators.has(x));
            
            // CONFLICT CHECK:
            // If both have DIFFERENT discriminators from the same category, DO NOT MERGE.
            // e.g. "Standard" vs "Gourmet" -> Conflict
            // e.g. "2" vs "3" -> Conflict
            const conflicts = [
                ['STANDARD', 'GOURMET'],
                ['OWNERS', 'GUEST', 'HALL', 'POWDER'],
                ['1', '2', '3', '4', '5'],
                ['MASTER', 'GUEST', 'HALL']
            ];

            let hasConflict = false;
            for (const group of conflicts) {
                const present = group.filter(g => allDiscriminators.has(g));
                if (present.length > 1) {
                    // If we have both "Standard" and "Gourmet" across the two rooms, 
                    // check if they are in the SAME room name (e.g. "Standard Gourmet"? Unlikely)
                    // If r1 has Standard and r2 has Gourmet -> Conflict!
                    const in1 = group.filter(g => id1.discriminators.has(g));
                    const in2 = group.filter(g => id2.discriminators.has(g));
                    if (in1.length > 0 && in2.length > 0 && in1[0] !== in2[0]) {
                        hasConflict = true;
                        break;
                    }
                }
            }
            if (hasConflict) continue;

            // MERGE RULES:
            // 1. If one is a subset of the other (e.g. "Kitchen" vs "Gourmet Kitchen") -> Merge into the more specific one
            // 2. If they share a strong discriminator (e.g. both have "Owners") -> Merge
            // 3. If one has NO discriminators (Generic "Kitchen") -> Merge into specific ("Standard Kitchen")

            const isSubset1 = d1.every(x => id2.discriminators.has(x)); // r1 is subset of r2
            const isSubset2 = d2.every(x => id1.discriminators.has(x)); // r2 is subset of r1
            
            if (isSubset1 || isSubset2) {
                // Merge!
                // Prefer the name with MORE discriminators (more specific)
                const target = d2.length > d1.length ? r2 : r1;
                const source = target === r1 ? r2 : r1;
                mergeMap.set(source, target);
            }
        }
    }

    // 3. Apply merges
    // Recursive lookup to handle chains (A->B, B->C => A->C)
    const getFinalName = (name: string): string => {
        let current = name;
        const visited = new Set<string>();
        while (mergeMap.has(current)) {
            if (visited.has(current)) break; // Circular protection
            visited.add(current);
            current = mergeMap.get(current)!;
        }
        return current;
    };

    items.forEach(item => {
        item.room = getFinalName((item.room || "General").trim());
    });

    return items;
}

// Helper: Consolidate identical items to prevent duplicates from multiple views
function consolidateItems(items: any[]): any[] {
    // First, merge rooms to ensure we are comparing items within the same logical room
    items = mergeSimilarRooms(items);

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
            
            // Keep the earliest sourcePage
            if (item.sourcePage && item.sourcePage > 0) {
                if (!existing.sourcePage || existing.sourcePage === 0 || item.sourcePage < existing.sourcePage) {
                    existing.sourcePage = item.sourcePage;
                }
            }

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
                const MAX_WIDTH = 2048; 
                const MAX_HEIGHT = 2048;

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
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7); // 0.7 Quality for better legibility
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
        currentRoom: "Unknown Room", // Default to Unknown to force extraction
        counts: { kitchen: 0, bath: 0 }, 
        lastKitchenRoom: null,
        lastBathRoom: null
    };
    
    // Split by page markers first to assign rooms
    // extractTextFromPdf adds "\n--- PAGE X ---\n"
    // Use case-insensitive split and handle potential extra whitespace
    const pages = text.split(/--- PAGE (\d+) ---/i);
    
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
    // 1. Standard Codes: Letters + Digits (e.g. B30, W3042)
    // 2. Complex Codes: With dashes, dots, slashes (e.g. W3042.BUTT, B15-L)
    // 3. Hardware/Accessory Keywords: Allow specific non-digit words (e.g. HINGE, FILLER, TOE KICK)
    const codeRegex = /\b(?:([A-Z]{1,5}\d{1,}[A-Z]*(?:[\s-\.]+[A-Z0-9\/]+)*)|(HINGE|FILLER|VALANCE|SKIN|PANEL|TOE|KICK|CORBEL|LEG|POST|TOUCH|KIT|DWR|UF|BUTT|L\/R|FH|FE|GLIDE|SLIDE|JOINT|SCREW|COVER|CAP|MOLDING|TRIM))\b/ig;

    const lines = chunk.split('\n');
    
    // Track if we are in a "Hardware" or "Finishing" section based on headers
    let isHardwareSection = false;
    
    // --- IMPROVED HEADER DETECTION (Regex) ---
    // Matches lines containing room types
    // Removed 'unit', 'plan', 'elevation', 'opt', 'type', 'garage', 'laundry', 'utility', 'mud', 'pantry' to prevent false positive rooms
    // We want to detect the MAIN ROOM NAME (e.g. "STANDARD 42 KITCHEN") not "Kitchen Plan" or "Garage Right"
    // STRICT MODE: Only KITCHEN and BATH/VANITY keywords allowed as per user request to avoid "extra rooms" like Living/Dining/Bed/Closet
    const roomTypeKeywords = /kitchen|bath|bathroom|vanity|ensuite|powder|restroom|owners|master/i;

    for (const line of lines) {
        if (line.length < 4) continue;
        if (line.includes('Page') && line.includes('of')) continue;
        
        const lower = line.toLowerCase();
        let potentialHeader = line.trim();

        // 1. Explicitly IGNORE "Garage" unless it's a "Garage Cabinet" list (unlikely for now based on user feedback)
        if (lower.includes('garage') && !lower.includes('cabinet')) continue;
        
        // 2. IGNORE "Plan", "Elevation", "Detail", "Section" as room headers
        // These are usually view labels, not distinct room names
        if (lower.includes('plan') || lower.includes('elevation') || lower.includes('detail') || lower.includes('section')) {
            continue;
        }
        
        // Check for specific Hardware/Finishing headers
        if (lower.includes('hardware') || lower.includes('accessories') || lower.includes('finishing') || lower.includes('miscellaneous')) {
             if (!lower.includes('kitchen') && !lower.includes('bath')) {
                 isHardwareSection = true;
                 context.currentRoom = "Hardware & Finishing";
                 continue;
             }
        }

        // --- IGNORED ROOM DETECTION ---
        // Explicitly catch Laundry, Utility, Garage headers to stop extraction until a valid room is found
        if (/laundry|utility|mudroom|pantry|garage|living|dining|closet|bedroom/i.test(line)) {
            // Only ignore if it does NOT contain Kitchen/Bath keywords
            if (!/kitchen|bath|vanity|ensuite|powder/i.test(line)) {
                // Check if it looks like a header (short, not a sentence, no codes)
                const isInstruction = /install|refer|note|see|drawing|scale|detail|section/i.test(line); 
                const isCode = /^[A-Z]{1,3}\d/.test(line); 
                
                if (!isInstruction && !isCode && potentialHeader.length < 50) {
                     console.log(`Local Regex: Entering Ignored Zone: "${potentialHeader}"`);
                     context.currentRoom = "IGNORE_ZONE";
                     isHardwareSection = false;
                     continue;
                }
            }
        }

        // --- ROOM HEADER DETECTION ---
        // We look for lines that contain a Room Type keyword
        if (roomTypeKeywords.test(line)) {
            // Filter out common false positives
            // REMOVED 'elevation' and 'plan' from exclusion list because "FLOOR PLAN" or "ELEVATION A" can be valid context
            const isInstruction = /install|refer|note|see|drawing|scale|detail|section/i.test(line); 
            // Removed 'cabinet' from exclusion because "KITCHEN CABINET PLAN" is a valid header
            // FIX: Use word boundaries to prevent "Basement" matching "base", "Wallace" matching "wall"
            const isItem = /\b(base|wall|tall|drawer|hinge|filler|faucet|sink|knob|pull|price|total|qty|quantity)\b/i.test(line);
            // Strict code check: Must start with 1-3 letters followed IMMEDIATELEY by a digit (e.g. W3042, B15). 
            // This avoids flagging "UNIT 204" or "STANDARD KITCHEN" as codes.
            const isCode = /^[A-Z]{1,3}\d/.test(line); 

            if (!isInstruction && !isItem && !isCode && potentialHeader.length < 100) {
                 // Clean up the header: remove non-alphanumeric prefix/suffix (keep quotes)
                 // But prioritize the original text for fidelity
                 let detectedText = potentialHeader;
                 
                 // If it looks like a valid room header
                 console.log(`Local Regex Found Room Header: "${detectedText}"`);
                 context.currentRoom = detectedText;
                 isHardwareSection = false;
                 
                 // Track Kitchens/Baths for context
                 if (/kitchen/i.test(detectedText)) {
                     // Always update if it's a new string, assuming PDF has distinct labels
                     if (context.lastKitchenRoom !== detectedText) {
                         context.counts.kitchen++;
                         context.lastKitchenRoom = detectedText;
                     }
                 } else if (/bath|vanity|ensuite/i.test(detectedText)) {
                     if (context.lastBathRoom !== detectedText) {
                         context.counts.bath++;
                         context.lastBathRoom = detectedText;
                     }
                 }
                 continue;
            }
        }


        // --- END HEADER DETECTION ---

        const matches = [...line.matchAll(codeRegex)];
        if (matches.length === 0) continue;
        
        let qty = 1;
        const qtyMatch = line.match(/^(\d+)\s*[-\s]\s*/); 
        if (qtyMatch) qty = parseInt(qtyMatch[1], 10);
        
        for (const match of matches) {
            // SKIP items in Ignored Zones
            if (context.currentRoom === "IGNORE_ZONE") continue;

            // Match[1] is standard code, Match[2] is hardware keyword
            const code = match[1] || match[2]; 
            if (!code) continue;

            if (code.match(/^\d{4}/)) continue;
            if (code.length > 30) continue;
            
            // INFER TYPE
            let type: CabinetType = 'Base';
            const upper = code.toUpperCase();
            if (upper.startsWith('W') || upper.startsWith('DC') || upper.startsWith('U')) type = 'Wall';
            else if (upper.startsWith('T') || upper.startsWith('O') || upper.startsWith('P')) type = 'Tall';
            else if (upper.startsWith('B') || upper.startsWith('SB') || upper.startsWith('DB') || upper.startsWith('LS') || upper.startsWith('VSB')) type = 'Base';
            else if (upper.match(/^(HINGE|FILLER|VALANCE|SKIN|PANEL|TOE|KICK|CORBEL|LEG|POST|TOUCH|KIT|DWR|UF)/)) type = 'Hardware';
            
             items.push({
                id: `local_${pageNum}_${items.length}`,
                originalCode: code,
                quantity: qty,
                type: type,
                description: generateDescriptionFromCode(code, type), 
                width: 0, height: 0, depth: 0,
                room: context.currentRoom,
                sourcePage: parseInt(pageNum) || 0
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
        const result = await generateWithFallback(ai, { parts: contentsParts }, generationConfig);

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
    let pagesToRender: number[] = []; // Track which pages are sent to Vision AI for merging logic later
    let aiCoveredPages = new Set<number>(); // Track pages covered by AI (Vision OR Text-Schedule)
    let localItems: CabinetItem[] = []; // Track local items for merging logic later
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
        let rawText = "";
        
        // 1. FAST PATH: Attempt Text Extraction & Local Regex Heuristics
        try {
             console.log("Attempting fast text extraction...");
             rawText = await extractTextFromPdf(file);
             
             // --- INSTANT LOCAL EXTRACTION (BYPASS AI) ---
             localItems = tryLocalRegexExtraction(rawText);
             
             // Extract unique room names to guide AI
             const detectedRooms = new Set<string>();
             localItems.forEach(i => {
                 if (i.room && i.room !== "Unknown Room" && i.room !== "General") detectedRooms.add(i.room);
             });
             
             if (detectedRooms.size > 0) {
                 console.log("Local Regex detected rooms:", Array.from(detectedRooms));
                 contentsParts.push({ text: `*** HINT: DETECTED ROOM NAMES ***
                 The following architectural room names were found in the document text. 
                 Please use these EXACT names for your room grouping where applicable:
                 ${Array.from(detectedRooms).map(r => `- ${r}`).join('\n')}
                 ***` });
             }
             
             // DISABLE FAST SCAN BYPASS: User reported accuracy issues. 
             // We will use localItems as a backup/baseline but ALWAYS consult AI for "Deep Scan".
             if (localItems.length >= 1) {
                 console.log(`Local Scan found ${localItems.length} items. Proceeding to AI for verification (Deep Scan).`);
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

             if (isRichText) { 
                  console.log(`Fast Path: Detected ${codeMatches.length} potential codes. Adding Text Context.`);
                  
                  // Optimize Text: Collapse multiple spaces to one, but PRESERVE NEWLINES for list structure
                  const optimizedText = rawText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n');
                  
                  contentsParts.push({ text: `*** DOCUMENT TEXT EXTRACTED (HINT ONLY) ***
                  The user uploaded a PDF. Below is the raw text content extracted programmatically.
                  Use this text to help identify codes that might be blurry in images.
                  HOWEVER, RELY ON THE IMAGES FOR COUNTS AND SPATIAL LOCATION (Floor Plan).
                  
                  RAW TEXT CONTENT:
                  ${optimizedText}
                  ***` });
                  
                  // ENABLE Smart Scan logic by flagging that we have text
                  processedWithText = true;
             }
        } catch (textErr) {
             console.warn("Text extraction failed/inadequate, continuing to image processing...", textErr);
        }

        // 2. DEEP SCAN: Vision Analysis (Smart Hybrid Mode)
        if (true) { // Always run vision, but strictly optimized
            try {
                console.log("Deep Scan: determining pages to render...");
                
                let totalPages = 0;

                // Smart Page Selection Logic
                // If we have text, we can be smart about which pages to render.
                if (processedWithText && rawText) {
                     // Use the rawText we already extracted
                     const fullText = rawText;
                     // Split by page markers
                     const pageSplits = fullText.split(/--- PAGE (\d+) ---/i);
                     // pageSplits = ["pre", "1", "content", "2", "content"...]
                     
                     // Determine total pages from the last index found
                     if (pageSplits.length > 1) {
                         const lastPageStr = pageSplits[pageSplits.length - 2]; // Second to last is the number
                         totalPages = parseInt(lastPageStr) || 0;
                     }

                     // Strategy:
                    // 1. ALWAYS render page 1 (Cover sheet) for context
                    // 2. PRIORITY: "Floor Plan" pages -> Vision AI
                    // 3. DATA: "Cabinet Schedule" pages -> Text AI (Do NOT render)
                    // 4. SECONDARY: "Elevation" pages -> Vision AI (Only if needed)
                    
                    const priorityPages = new Set<number>(); // Floor Plans (Vision)
                    const secondaryPages = new Set<number>(); // Elevations (Vision)
                    const schedulePages = new Set<number>(); // Schedules (Text Only)
                    
                    // Add Cover Page
                    priorityPages.add(1);

                    // Analyze text content for each page
                    for (let i = 1; i < pageSplits.length; i += 2) {
                        const pNum = parseInt(pageSplits[i]);
                        const pContent = pageSplits[i+1] || "";
                        const lower = pContent.toLowerCase();

                        // Strongest Signal: "Floor Plan", "Plan View"
                        // EXPANDED for Deep Scan: Catch "Level 1", "Ground Floor", "Unit 101", "Phase 2"
                        const isFloorPlan = /floor\s*plan|plan\s*view|overhead|layout|level\s*\d|story\s*\d|ground\s*floor|first\s*floor|second\s*floor|unit\s*[\w\d]+|phase\s*\d/i.test(lower);
                        
                        // Cabinet Schedule Signal: "Schedule", "Legend", "Bill of Materials"
                        // Must contain "Qty" or "Quantity" to be a real list
                        const isSchedule = (/schedule|legend|bill|material|list/i.test(lower)) && (/qty|quantity|desc/i.test(lower));
                        
                        // Weak Signal: "Elevation" or just "Kitchen"
                        // Only count as Room if we also see potential cabinet codes (e.g. B30, W30) to avoid text-only specs
                        const hasCodes = /[BW]\d{2}/.test(pContent); 
                        const isElevation = /elevation|view/i.test(lower);
                        const isRoom = /kitchen|bath/i.test(lower);
                        const hasScale = /scale:/i.test(lower);

                        // Exclude Text/Spec pages
                        const isSpec = /warranty|maintenance|terms and conditions|specifications/i.test(lower);

                        if (!isSpec) {
                            if (isSchedule) {
                                schedulePages.add(pNum);
                                // If it's a schedule, we rarely need to see it if we have the text.
                                // But sometimes schedules are images. 
                                // Optimization: If we have extracted > 100 chars from this page, assume Text is good enough.
                                if (pContent.length < 100) {
                                    // Text extraction failed, so we MUST render it
                                    priorityPages.add(pNum); 
                                }
                            } else if (isFloorPlan) {
                                priorityPages.add(pNum);
                            } else if ((isElevation || isRoom) && (hasScale || hasCodes)) {
                                // Only add secondary pages if they look like drawings (Scale) or have codes
                                secondaryPages.add(pNum);
                            }
                        }
                    }
                    
                    // Decision Time:
                    // If we found ANY priority pages (besides cover), IGNORE secondary pages completely.
                    // This is the "Aggressive Optimization" for speed.
                    let finalPages = Array.from(priorityPages).sort((a,b) => a - b);
                    
                    // Only use secondary pages if we have FEW floor plans (e.g. just cover + 1)
                    // Or if the user wants "Deep Scan" (we are implicit here)
                    if (finalPages.length <= 2 && secondaryPages.size > 0) {
                        console.log("Smart Scan: Few Floor Plans found. Supplementing with Elevations.");
                        const secondaryArray = Array.from(secondaryPages).sort((a,b) => a - b);
                        // Add up to 3 secondary pages (Reduced from 5)
                        finalPages = [...finalPages, ...secondaryArray.slice(0, 3)].sort((a,b) => a - b);
                    }
                    
                    pagesToRender = finalPages;
                    
                    // Cap at 8 pages for Fast Deep Scan (User Requirement: < 1 min)
                    // Reduced from 10 to 8 to ensure speed on large files while keeping key content.
                    if (pagesToRender.length > 8) {
                        console.log(`Smart Scan: Too many pages (${pagesToRender.length}). Truncating to top 8.`);
                        pagesToRender = pagesToRender.slice(0, 8);
                    }
                    
                    // --- SMART TEXT INJECTION ---
                    // Inject the specific text from Schedule Pages as a high-priority hint
                    if (schedulePages.size > 0) {
                        // Mark these pages as "Covered" by AI (Text Mode)
                        schedulePages.forEach(p => aiCoveredPages.add(p));
                        
                        const scheduleText = Array.from(schedulePages).map(p => {
                            const splitIndex = pageSplits.indexOf(String(p));
                            if (splitIndex > -1 && splitIndex + 1 < pageSplits.length) {
                                return `--- PAGE ${p} (CABINET SCHEDULE) ---\n${pageSplits[splitIndex+1]}`;
                            }
                            return "";
                        }).join('\n');
                        
                        if (scheduleText.length > 10) {
                            console.log(`Smart Scan: Injected text from ${schedulePages.size} Schedule pages.`);
                            contentsParts.push({ text: `*** PRIORITY DATA: CABINET SCHEDULE (TEXT SOURCE) ***
                            The following text comes from pages identified as 'Cabinet Schedules' or 'Item Lists'.
                            Use this text as the AUTHORITATIVE source for Codes, Descriptions, and Dimensions.
                            
                            ${scheduleText}
                            *** END SCHEDULE DATA ***` });
                        }
                    }
                    
                    // Smart Scan: Identified pages
                    if (pagesToRender.length > 0) {
                         console.log(`Smart Scan: Identified ${pagesToRender.length} optimized pages: ${pagesToRender.join(', ')}`);
                    }
                }

                // SAFETY NET: If Smart Scan failed (no text or no keywords found), 
                // DO NOT render all 100 pages. Default to a safe subset.
                if (pagesToRender.length === 0) {
                     console.warn("Smart Scan: No specific pages identified (or text extraction failed). Defaulting to first 8 pages.");
                     // Create array [1, 2, ... 8]
                     pagesToRender = Array.from({ length: 8 }, (_, i) => i + 1);
                }

                // FINAL CAP: Ensure we never accidentally request too many pages
                // even if logic above went wrong.
                if (pagesToRender.length > 8) {
                     console.log(`Deep Scan: Capping page count at 8 (requested ${pagesToRender.length}) for performance.`);
                     pagesToRender = pagesToRender.slice(0, 8);
                }

                // Mark rendered pages as covered
                pagesToRender.forEach(p => aiCoveredPages.add(p));

                console.log("Deep Scan: Converting pages to images for AI...");
                // Pass the specific list of pages to render
                const pdfImages = await convertPdfToImages(file, pagesToRender);
                
                if (pdfImages.length === 0) {
                    throw new Error("PDF processing failed: No pages found.");
                }

                console.log(`Successfully converted ${pdfImages.length} PDF pages to images.`);

                // Add document info
                contentsParts.push({ text: `*** DOCUMENT INFO: 
                Processing ${pdfImages.length} selected pages as IMAGES for visual analysis.
                (Pages: ${pdfImages.map(p => p.pageNumber).join(', ')})
                
                CRITICAL INSTRUCTION:
                You MUST iterate through ALL provided images.
                The images provided are the MOST RELEVANT pages (Floor Plans, Elevations).
                Use the previously provided TEXT HINT for the remaining pages if needed.
                
                REQUIRED SCRATCHPAD FORMAT:
                "Analyzing Page X..."
                [findings]
                ***` });

                // Add each page as a separate image part
                pdfImages.forEach(img => {
                    contentsParts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.data
                        }
                    });
                    // Add a text separator to help AI distinguish pages
                    contentsParts.push({ text: `[--- IMAGE FOR PAGE ${img.pageNumber} ---]` });
                });
                
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
        maxOutputTokens: 8192, // Standard max for Flash models (sufficient for JSON output)
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
                                room: { type: "STRING", description: "CRITICAL: The specific room/area this item belongs to (e.g. 'Kitchen', 'Master Bath', 'Laundry', 'Pantry'). Look for Room Names on the plan labels or title blocks. Do NOT default to 'General' if a room name is visible." },
                                qty: { type: "NUMBER" },
                                type: { type: "STRING", description: "Base, Wall, Tall, Filler, Panel, Accessory, Hardware, Finishing" },
                                description: { type: "STRING" },
                                width: { type: "NUMBER" },
                                height: { type: "NUMBER" },
                                depth: { type: "NUMBER" },
                                extractedPrice: { type: "NUMBER" },
                                sourcePage: { type: "NUMBER", description: "The Page Number where this item was found." },
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
            const result = await generateWithFallback(ai, { parts: contentsParts }, generationConfig);
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
            
            // PRIORITY: NKBA Code Prefixes (User Explicit Request)
            // Prevent short codes like "B" from matching unrelated things if description contradicts, but usually safe.
            // We check for length > 1 to avoid matching just "W" if it's a typo.
            const isCode = code.length >= 2;

            if (isCode && (code.startsWith('W') || code.startsWith('DC') || code.startsWith('WDC'))) {
                 type = 'Wall';
            } else if (isCode && (code.startsWith('T') || code.startsWith('U') || code.startsWith('O') || code.startsWith('P') || rawType.includes('tall') || rawType.includes('pantry'))) {
                 type = 'Tall';
            } else if (isCode && (code.startsWith('B') || code.startsWith('SB') || code.startsWith('DB') || code.startsWith('LS') || code.startsWith('VSB') || code.startsWith('K') || code.startsWith('V'))) {
                 // K for Knee Drawer, V for Vanity
                 type = 'Base';
            }
            // SECONDARY: Description/Type Analysis (if code didn't catch it or wasn't standard)
            else if (rawType.includes('wall')) type = 'Wall';
            else if (rawType.includes('filler')) type = 'Filler';
            else if (rawType.includes('panel') || rawType.includes('skin')) type = 'Panel';
            else if (rawType.includes('finishing') || rawType.includes('touch') || rawType.includes('marker') || rawType.includes('putty') || rawType.includes('fill') || rawType.includes('paint') || rawType.includes('stain')) type = 'Finishing';
            else if (rawType.includes('hardware') || rawType.includes('hinge') || rawType.includes('glide') || rawType.includes('joint') || rawType.includes('screw') || rawType.includes('bracket')) type = 'Hardware';
            else if (rawType.includes('appliance') || rawType.includes('fridge') || rawType.includes('range') || rawType.includes('dishwasher')) type = 'Appliance';
            else if (rawType.includes('accessory') || rawType.includes('molding') || rawType.includes('kit') || rawType.includes('toe') || rawType.includes('valance') || rawType.includes('corbel')) type = 'Accessory';
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
                sourcePage: typeof item.sourcePage === 'number' ? item.sourcePage : 0,
                notes: item.notes || "",
                extractedPrice: item.extractedPrice || undefined,
                modifications: Array.isArray(item.modifications) ? item.modifications : []
            };
        });

    // Fix: Prioritize Text Items properly
    // If AI found < 5 items but Local found > 10, maybe the vision scan failed or was truncated.
    // In this case, we TRUST the local text scan more for the bulk of items.
    let finalItems = items;
    const aiCount = items.length;
    const localCount = localItems.length;

    // Use a simpler merge strategy:
    // 1. Take all AI items (they have better room context usually)
    // 2. Take Local items ONLY if they are from pages NOT covered by AI
    // 3. BUT if AI count is suspiciously low (0 or < 10% of local), perform a Rescue Merge
    
    const filteredLocalItems = localItems.filter(i => !i.sourcePage || !aiCoveredPages.has(i.sourcePage));

    if (aiCount < 5 && localCount > 20) {
        console.warn(`AI found significantly fewer items (${aiCount}) than Local Text Scan (${localCount}). Rescuing all local items.`);
        // Union all unique items
        finalItems = [...items, ...localItems];
    } else {
         console.log(`Merging Logic:
        - AI Items: ${items.length} (from pages ${Array.from(aiCoveredPages).sort((a,b)=>a-b).join(',')})
        - Text Scan Items (Total): ${localItems.length}
        - Text Scan Items Added (Fallback): ${filteredLocalItems.length}`);
        
        finalItems = [...items, ...filteredLocalItems];
    }

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
        items: consolidateItems(finalItems)
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
            return await generateWithFallback(ai, { parts: [{ text: prompt }, { text: dataStr }] }, { 
                responseMimeType: "application/json",
                temperature: 0.0 // Deterministic
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

// Helper to generate descriptive text from code when AI fails or Local Extract is used
function generateDescriptionFromCode(code: string, type: CabinetType): string {
    const c = code.toUpperCase();
    
    // Fillers
    if (c.startsWith('UF')) return `Universal Filler ${c.replace('UF', '')}`;
    if (c.startsWith('F') && !isNaN(parseInt(c[1]))) return `Filler ${c.replace('F', '')}`;
    if (c.startsWith('WF')) return `Wall Filler ${c.replace('WF', '')}`;
    if (c.startsWith('TF')) return `Tall Filler ${c.replace('TF', '')}`;
    
    // Wall
    if (type === 'Wall') {
        if (c.startsWith('W')) {
            // W3042 -> Wall Cabinet 30" W x 42" H
            // W304224 -> Wall Cabinet 30" W x 42" H x 24" D
            const nums = c.match(/\d+/);
            if (nums) {
                const n = nums[0];
                if (n.length === 4) return `Wall Cabinet ${n.substring(0,2)}" W x ${n.substring(2)}" H`;
                if (n.length === 6) return `Wall Cabinet ${n.substring(0,2)}" W x ${n.substring(2,4)}" H x ${n.substring(4)}" D`;
            }
            return "Wall Cabinet";
        }
        if (c.startsWith('DC') || c.startsWith('WDC')) return "Diagonal Corner Wall Cabinet";
        if (c.startsWith('WBC')) return "Blind Corner Wall Cabinet";
    }

    // Base
    if (type === 'Base') {
        if (c.startsWith('B')) {
            const nums = c.match(/\d+/);
            if (nums) return `Base Cabinet ${nums[0]}"`;
            return "Base Cabinet";
        }
        if (c.startsWith('SB')) return `Sink Base ${c.replace('SB', '')}"`;
        if (c.startsWith('DB')) return `Drawer Base ${c.replace('DB', '')}"`;
        if (c.startsWith('LS')) return "Lazy Susan Base";
        if (c.startsWith('BEC')) return "Base End Cabinet";
        if (c.startsWith('BBC')) return "Blind Base Corner";
    }

    // Tall
    if (type === 'Tall') {
        if (c.startsWith('T') || c.startsWith('U')) {
             const nums = c.match(/\d+/);
             if (nums && nums[0].length >= 4) return `Tall Cabinet ${nums[0].substring(0,2)}" W x ${nums[0].substring(2)}" H`;
             return "Tall Utility Cabinet";
        }
        if (c.startsWith('O')) return "Oven Cabinet";
    }

    // Vanity
    if (type === 'Vanity') {
        if (c.startsWith('VSB')) return `Vanity Sink Base ${c.replace('VSB', '')}"`;
        if (c.startsWith('VDB')) return `Vanity Drawer Base ${c.replace('VDB', '')}"`;
    }

    return "Extracted Item";
}
