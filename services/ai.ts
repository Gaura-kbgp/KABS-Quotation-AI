import { GoogleGenAI } from "@google/genai";
import { CabinetItem, ProjectSpecs, CabinetType } from "../types";
import { normalizeNKBACode } from "./pricingEngine";
import { extractTextFromPdf, convertPdfToImages } from "./pdfUtils";

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
    let retries = 0;
    const maxRetries = 5;
    let delay = 1000; // Start with 1 second

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

            // If it's a rate limit error (429), implement exponential backoff.
            if (error.status === 429 && retries < maxRetries) {
                retries++;
                console.log(`Rate limit hit. Retrying in ${delay / 1000}s... (Attempt ${retries}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Double the delay for the next retry
                continue; // Retry the same model
            }
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

### **CRITICAL: NKBA NOMENCLATURE (The #1 Priority)**
- **You MUST understand and use NKBA (National Kitchen & Bath Association) cabinet codes.**
- **FORMAT**: [Type][Width][Height]. Example: W3030
- **Wall (W)**: W[Width][Height]. W3030 = 30" wide, 30" high. Standard depth is 12", so it is omitted.
- **Base (B)**: B[Width]. B18 = 18" wide. Standard height (34.5") and depth (24") are omitted.
- **Sink Base (SB)**: SB[Width]. SB36 = 36" wide sink base.
- **Tall (T)**: T[Width][Height]. T1884 = 18" wide, 84" high.
- **Vanity (V)**: V[Width]. V30 = 30" wide. Standard depth is 21".
- **DIMENSION EXTRACTION**: From a code like W3030, you MUST extract width: 30, height: 30.
- **If depth is non-standard, it is added at the end**: W362424 = 36"W x 24"H x 24"D.

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
   - Codes starting with: T, O, P.

5. **Fillers** (Type: "Filler")
   - Codes starting with: F, WF, TF, U, UF.
   - **Universal Fillers (U, UF)** MUST be categorized as "Filler".
   - **Strictly separate** Fillers from Cabinets.

6. **Hardware & Finishing** (Type: "Hardware")
   - **EXACT MATCH**: Extract hardware names/codes EXACTLY as written.
   - Includes: Handles, Knobs, Hinges, Legs, Rods, Skin, Panel, Molding, Valance, Corbel, Toe Kick (TK), Touch-up kits, paint.

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
- **DO NOT** include "MI HOMES", "SARASOTA", "MAGNOLIA", "GARAGE RIGHT", or "1951" in the final room name.
- **ONLY** use the functional room name: "STANDARD 42\" KITCHEN".

### **CRITICAL: ROOM GROUPING & CONTEXTUAL MERGING**
- **ONE ROOM, MULTIPLE PAGES**: A single room (like "Kitchen") often spans multiple pages (Floor Plan, Elevations A, B, C, Hardware Lists).
- **MERGE THEM**: You MUST group all items from these related pages into **ONE single room entry**.
- **REUSE EXACT NAMES**: If Page 1 says "STANDARD 42\" KITCHEN" and Page 2 says "STANDARD KITCHEN PLAN", output "STANDARD 42\" KITCHEN" for BOTH. Do not create variations.
- **CONTEXTUAL ASSOCIATION RULE**: If a page does NOT contain a floor plan or elevation drawing, and primarily lists items like "Hinges", "Knobs", "Molding", "Panels", or "Fillers", you MUST assign these items to the **last major room** you identified (e.g., "STANDARD KITCHEN", "OWNERS BATH").
- **ABSOLUTE RULE**: **NEVER** use "HARDWARE & FINISHING", "ACCESSORIES", or "HINGES & HARDWARE" as a room name. These are categories, not rooms. If you see these as a title, apply the Contextual Association Rule immediately.
- **EXAMPLE OF CONTEXTUAL MERGING**:
  - Page 1 contains a floor plan titled "GOURMET KITCHEN". You extract 10 cabinets for this room.
  - Page 2 contains a list titled "HARDWARE & ACCESSORIES" with no floor plan. You extract 5 hinges and 20 knobs.
  - **CORRECT ACTION**: Assign the 5 hinges and 20 knobs to the "GOURMET KITCHEN" room.
  - **INCORRECT ACTION**: Creating a new room called "HARDWARE & ACCESSORIES".

### **CRITICAL: ROOM SEQUENCE & NAMING**
- **ORDER MATTERS**: You MUST process rooms in the **EXACT ORDER** they appear in the PDF pages.
- **NO REORDERING**: Do not group all "Kitchens" together.
- **TITLE BLOCK PRIORITY**: The Room Name is usually in the main Title Block (bottom/side of the page) or the largest text label.
  - **Preferred**: "STANDARD 42\" KITCHEN", "OPT GOURMET KITCHEN", "STANDARD OWNERS BATH".
  - **Avoid**: "Kitchen" (Too generic), "GARAGE RIGHT" (Not a room with cabinets), "MI HOMES" (Builder name).
  - **Use the **Full Architectural Name** found on the page.

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
            .replace(/\bSTD\b/g, 'STANDARD') // Normalize abbreviations
            .replace(/\bOPT\b/g, 'OPTION') // Normalize abbreviations
            .replace(/\bGMT\b/g, 'GOURMET') // Normalize abbreviations
            .replace(/PLAN|ELEVATION|VIEW|DETAIL|SECTION|PAGE|LEVEL|FLOOR|LAYOUT|SCHEMATIC|DRAWING/g, '') // Remove view types
            .replace(/GARAGE\s*(RIGHT|LEFT)/g, '') // Remove location specific noise
            .replace(/MIH|MI\sHOMES|HOME|SARASOTA/g, '') // Remove builder-specific noise
            .replace(/GR\s*\d+/g, '') // Remove codes like GR 1951
            .replace(/\b\d{4,}\b/g, '') // Remove long numbers (likely job/plan numbers)
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

// New: A rule-based type classifier that overrides the AI. This is the source of truth.
function getTypeFromCode(code: string): CabinetType | null {
    const c = code.toUpperCase().trim();
    if (!c) return null;

    // Vanity is most specific, check first
    if (c.startsWith('VSB') || c.startsWith('VDB') || c.startsWith('V')) {
        return 'Vanity';
    }
    // Wall cabinets (including corner types)
    if (c.startsWith('W') || c.startsWith('DC') || c.startsWith('WDC') || c.startsWith('WBC')) {
        return 'Wall';
    }
    // Base cabinets (including all corner and sink types)
    if (c.startsWith('B') || c.startsWith('SB') || c.startsWith('SKB') || c.startsWith('DB') || c.startsWith('LS') || c.startsWith('BEC') || c.startsWith('BBC') || c.startsWith('K') || c.startsWith('BTK') || c.startsWith('SHB') || c.startsWith('BC') || c.startsWith('EZR') || c.startsWith('DCB')) {
        return 'Base';
    }
    // Tall cabinets
    if (c.startsWith('T') || c.startsWith('O') || c.startsWith('P')) {
        return 'Tall';
    }
    // Fillers
    if (c.startsWith('F') || c.startsWith('UF') || c.startsWith('U') || c.startsWith('WF') || c.startsWith('TF')) {
        return 'Filler';
    }

    return null; // No rule matched
}

// New: Generate a human-readable description from an NKBA-style cabinet code.
function generateDescriptionFromCode(code: string, type: CabinetType): string {
    const c = (code || "").toUpperCase().trim();
    if (!c) return "Extracted Item";

    // Use regex to find the first letter-based prefix.
    const prefixMatch = c.match(/^[A-Z]+/);
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const numbers = c.substring(prefix.length);

    let description = "";
    let width = 0, height = 0, depth = 0;

    // This is a simplified parser. It assumes the numbers follow the prefix directly.
    // W3030 -> prefix: W, numbers: 3030
    // B15 -> prefix: B, numbers: 15
    // SB30 -> prefix: SB, numbers: 30
    // W362424 -> prefix: W, numbers: 362424

    switch (type) {
        case 'Wall':
            description = "Wall Cabinet";
            if (numbers.length === 4) { // W3030
                width = parseInt(numbers.substring(0, 2));
                height = parseInt(numbers.substring(2, 4));
            } else if (numbers.length === 6) { // W362424
                width = parseInt(numbers.substring(0, 2));
                height = parseInt(numbers.substring(2, 4));
                depth = parseInt(numbers.substring(4, 6));
            }
            break;
        case 'Base':
            if (prefix.startsWith('S')) description = "Sink Base Cabinet";
            else if (prefix.includes('C') || prefix.includes('LS') || prefix.includes('EZR')) description = "Corner Base Cabinet";
            else description = "Base Cabinet";
            
            if (numbers.length >= 2) { // B15, SB30
                width = parseInt(numbers.substring(0, 2));
            }
            break;
        case 'Tall':
            description = "Tall Cabinet";
            if (numbers.length === 4) { // T1884
                width = parseInt(numbers.substring(0, 2));
                height = parseInt(numbers.substring(2, 4));
            } else if (numbers.length === 6) { // T188424
                width = parseInt(numbers.substring(0, 2));
                height = parseInt(numbers.substring(2, 4));
                depth = parseInt(numbers.substring(4, 6));
            }
            break;
        case 'Vanity':
            if (prefix.startsWith('S')) description = "Vanity Sink Base";
            else description = "Vanity Cabinet";
            if (numbers.length >= 2) { // V30
                width = parseInt(numbers.substring(0, 2));
            }
            break;
        case 'Filler':
            description = "Filler";
            if (numbers.length >= 2) {
                width = parseInt(numbers.substring(0, 2));
            }
            break;
        default:
            // For hardware or other non-dimensional items, return the code itself
            return code;
    }

    let finalDesc = description;
    if (width > 0) finalDesc += ` ${width}"W`;
    if (height > 0) finalDesc += ` x ${height}"H`;
    if (depth > 0) finalDesc += ` x ${depth}"D`;

    return finalDesc.trim();
}

export async function analyzePlan(
    file: File, 
    nkbaRules?: any, 
    onProgress?: (message: string) => void
): Promise<{ items: CabinetItem[], specs: ProjectSpecs }> {
    const ai = getAI();
    let items: CabinetItem[] = [];
    let specs: ProjectSpecs = {};

    const fileType = file.type;

    let contents: any[];

    if (fileType === 'application/pdf') {
        let text = "";
        try {
            onProgress?.("Extracting text from PDF...");
            text = await extractTextFromPdf(file);
        } catch (e) {
            console.error("Text extraction failed, falling back to images", e);
        }
        
        if (!text || text.trim().length < 50) {
            onProgress?.("Text extraction failed. Converting PDF to images for analysis...");
            const images = await convertPdfToImages(file);
            contents = [
                { text: SYSTEM_INSTRUCTION },
                ...images.map(img => ({
                    inlineData: {
                        data: img.data,
                        mimeType: img.mimeType
                    }
                }))
            ];
        } else {
            contents = [
                { text: SYSTEM_INSTRUCTION },
                { text: `EXTRACTED TEXT:\n${text}` }
            ];
        }

    } else if (fileType.startsWith('image/')) {
        const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        contents = [
            { text: SYSTEM_INSTRUCTION },
            {
                inlineData: {
                    data: base64,
                    mimeType: file.type
                }
            }
        ];
    } else {
        throw new Error("Unsupported file type. Please upload a PDF or an image.");
    }
    
    if (nkbaRules) {
        contents.unshift({ text: `ADDITIONAL NKBA RULES:\n${JSON.stringify(nkbaRules, null, 2)}` });
    }

    onProgress?.("Analyzing document with AI...");
    const result = await generateWithFallback(ai, contents, {
        temperature: 0.0,
        topK: 1,
    });

    if (!result || !result.candidates || result.candidates.length === 0) {
        throw new Error("AI analysis failed. No valid response received.");
    }

    const rawJson = result.candidates[0].content.parts[0].text
        .trim();

        // New, more robust JSON parsing
        const firstBrace = rawJson.indexOf('{');
        const lastBrace = rawJson.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
            throw new Error('No valid JSON object found in the AI response.');
        }
        const jsonContent = rawJson.substring(firstBrace, lastBrace + 1);
        
        const aiResult = JSON.parse(jsonContent);
    
    items = aiResult.items || [];
    specs = aiResult.specs || {};

    items.forEach(item => {
        item.id = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        item.normalizedCode = normalizeNKBACode(item.originalCode);
        
        const ruleType = getTypeFromCode(item.normalizedCode);
        if (ruleType) {
            item.type = ruleType;
        }

        if (!item.description || item.description.trim() === "Extracted Item") {
            item.description = generateDescriptionFromCode(item.normalizedCode, item.type);
        }
    });

    items = consolidateItems(items);

    return { items, specs };
}