import { GoogleGenAI, Type } from "@google/genai";
import { CabinetItem, ProjectSpecs, CabinetType } from "../types";
import { normalizeNKBACode } from "./pricingEngine";

// Using import.meta.env.VITE_GEMINI_API_KEY as per guidelines
const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

// Updated to 2.5 series as per user request (2026 models)
const MODEL_NAME = 'gemini-2.5-pro'; 
const FAST_MODEL_NAME = 'gemini-2.5-flash'; 

const SYSTEM_INSTRUCTION = `
ROLE: Expert Cabinetry Quantity Surveyor & AI Vision Analyst.

TASK: Extract a COMPREHENSIVE, 100% ACCURATE Bill of Materials from the provided architectural plans, elevations, or quote tables.

INPUT: PDF or Image containing drawings, schedules, or tables.

CRITICAL OBJECTIVE: HIGH RECALL.
- You must find EVERY cabinet code.
- If there are 19 cabinets in the plan, you MUST output 19 items.
- If you only find 4, you have FAILED.
- Scan the entire image/PDF pixel-by-pixel, top-to-bottom, left-to-right.
- CHECK ALL PAGES. Do not stop after Page 1.

OUTPUT REQUIREMENT:
You must output a SINGLE JSON object containing 'specs' and 'items'.

CRITICAL EXTRACTION RULES:
1. **EXHAUSTIVE LISTING (NO SUMMARIZATION)**:
   - If the document contains a table with 20 rows, your JSON 'items' array MUST have 20 objects.
   - **DO NOT GROUP**: Do not output "3x Base Cabinet". Output 3 separate entries.
   - **Visual Search**: In drawing/plan views, look for codes (e.g., "B15", "W3030", "SB36") attached to rectangles.
   - **Review**: After extracting, look again. Did you miss any text labels?

2. **DEALING WITH DRAWINGS (ELEVATIONS/PLANS)**:
   - OCR every text label that looks like a cabinet code.
   - Look for labels pointing to cabinets, e.g., "W3024", "B21L", "PB36", "MW.HOOD".
   - Codes are often written directly on the cabinet face in the drawing.
   - **Duplicate Codes**: If "B15" appears in two places on the floor plan, that means there are TWO B15 cabinets. Extract BOTH.

3. **FILTERING (BE SMART)**:
   - INCLUDE: Cabinets, Fillers, Panels, Moldings, Accessories, Wood Hoods, "Sink Base", "Oven Cabinet", "Microwave Cabinet".
   - EXCLUDE: The actual appliances (Fridge, Stove, Dishwasher), Sinks, Faucets, Electrical, Plumbing.
   - **Ambiguity Rule**: If you are unsure if something is a cabinet or an appliance, INCLUDE IT. It is better to have an extra item than to miss a cabinet.

JSON SCHEMA:
{
  "specs": {
    "manufacturer": "string",
    "doorStyle": "string", 
    "finish": "string",
    "notes": "string"
  },
  "items": [
    {
      "code": "string (EXACT text found, e.g. 'VDB24-AH')",
      "qty": number (default 1),
      "description": "string",
      "width": number (extract from code or desc if available, else 0),
      "height": number,
      "depth": number
    }
  ]
}
`;

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

    // Fix 6: Missing comma after number in array (e.g. [1 2] -> [1, 2])
    clean = clean.replace(/(\d+)\s+(\d+)/g, '$1, $2');

    // Fix 7: Missing comma after number before quote (e.g. 1 "a" -> 1, "a")
    clean = clean.replace(/(\d+)\s+"/g, '$1, "');

    // Fix 8: Round tiny floating point numbers (e.g. 3.000...e-21 -> 0)
    clean = clean.replace(/(\d+\.?\d*)e-[0-9]+/gi, '0');
    // Fix 9: Round long decimals (e.g. 33.000000001 -> 33)
    clean = clean.replace(/(\d+\.\d{4,})/g, (match) => {
        return String(Math.round(parseFloat(match) * 100) / 100);
    });

    try {
        return JSON.parse(clean);
    } catch (e) {
        console.warn("JSON Parse Error. Attempting auto-repair...", e);
        try {
            // Aggressive Repair 1: Try to find the valid JSON object wrapper
            let start = clean.indexOf('{');
            let end = clean.lastIndexOf('}');
            
            // If we have a start but the end is "too early" (likely inside an item), 
            // check if we have an unclosed array.
            if (start !== -1) {
                let candidate = clean.substring(start, end + 1);
                
                // If the candidate doesn't end with } or ]}, it might be truncated.
                // But lastIndexOf('}') guarantees it ends with }.
                // The problem is if the array ] is missing.
                
                // Check if braces/brackets are balanced
                const openBraces = (candidate.match(/{/g) || []).length;
                const closeBraces = (candidate.match(/}/g) || []).length;
                const openBrackets = (candidate.match(/\[/g) || []).length;
                const closeBrackets = (candidate.match(/\]/g) || []).length;
                
                if (openBrackets > closeBrackets) {
                    // We are likely inside an open array.
                    // Let's try to close it.
                    // Find the last complete object closing `},` or `}` inside the array.
                    // Strategy: Cut off at the last `}` and append `]}`
                    candidate = candidate + "]}"; 
                }
                
                try { return JSON.parse(candidate); } catch (e2) {}
                
                // Aggressive Repair 2: Truncate to last known good object
                // If the JSON is like { items: [ {good}, {good}, {ba
                // We want to keep the good ones.
                const lastGoodObj = clean.lastIndexOf('},');
                if (lastGoodObj > start) {
                     let truncated = clean.substring(start, lastGoodObj + 1) + "]}";
                     try { return JSON.parse(truncated); } catch (e3) {}
                }
            }
            
            // Original repair logic as fallback
            if (start !== -1 && end !== -1) {
                let jsonStr = clean.substring(start, end + 1);
                jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1'); 
                jsonStr = jsonStr.replace(/}\s*{/g, '},{');
                jsonStr = jsonStr.replace(/]\s*"/g, '],"');
                jsonStr = jsonStr.replace(/}\s*"/g, '},"');
                jsonStr = jsonStr.replace(/"\s*"/g, '","');
                jsonStr = jsonStr.replace(/(\d+)\s+(\d+)/g, '$1, $2');
                return JSON.parse(jsonStr);
            }
            throw new Error("No valid JSON object found");
        } catch (repairError) {
            console.error("JSON Repair Failed:", repairError);
            console.error("Bad JSON Content:", clean); // Log content for debugging
            return { items: [], specs: {} };
        }
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

    let base64Data: string;

    // Only resize if it is an image
    if (mimeType.startsWith('image/')) {
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
    } else {
        // For PDFs, check size limit (Gemini Inline Data Limit is ~20MB safety margin)
        const MAX_PDF_SIZE = 19 * 1024 * 1024; // 19MB to be safe
        if (file.size > MAX_PDF_SIZE) {
            throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit is 19MB. Please compress the PDF or split it.`);
        }

        // For PDFs, read directly without resizing
        base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(cleanBase64(reader.result as string));
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    try {
        const ai = getAI();
        
        const contentsParts: any[] = [
            { 
                inlineData: { 
                    mimeType: mimeType, 
                    data: base64Data 
                } 
            },
            { text: SYSTEM_INSTRUCTION }
        ];

        const response = await callAIWithRetry(async () => {
            const result = await ai.models.generateContent({
                model: MODEL_NAME,
                contents: { parts: contentsParts },
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            specs: {
                                type: Type.OBJECT,
                                properties: {
                                    manufacturer: { type: Type.STRING, description: "Manufacturer Name if found" },
                                    doorStyle: { type: Type.STRING, description: "Door Style Name" },
                                    finish: { type: Type.STRING, description: "Finish/Color Name" },
                                    construction: { type: Type.STRING, description: "Construction specs" },
                                    notes: { type: Type.STRING, description: "Any other project notes" }
                                }
                            },
                            items: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        code: { type: Type.STRING, description: "The Exact Product Code (e.g. VDB27AH-3)" },
                                        normalizedCode: { type: Type.STRING, description: "NKBA equivalent code" },
                                        qty: { type: Type.NUMBER },
                                        type: { type: Type.STRING, description: "Base, Wall, Tall, Filler, Panel, Accessory" },
                                        description: { type: Type.STRING },
                                        width: { type: Type.NUMBER },
                                        height: { type: Type.NUMBER },
                                        depth: { type: Type.NUMBER },
                                        extractedPrice: { type: Type.NUMBER },
                                        modifications: {
                                            type: Type.ARRAY,
                                            items: {
                                                type: Type.OBJECT,
                                                properties: {
                                                    description: { type: Type.STRING, description: "e.g. Finish End Left" },
                                                    price: { type: Type.NUMBER }
                                                }
                                            }
                                        },
                                        notes: { type: Type.STRING }
                                    },
                                    required: ["code", "qty", "type", "description"]
                                }
                            }
                        },
                        required: ["items", "specs"]
                    },
                    temperature: 0.1,
                    maxOutputTokens: 8192, 
                }
            });
            console.log("Raw AI Response:", result.text); // Debugging
            return result;
        });
        
        const result = safeJSONParse(response.text || "{}");
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
            
            if (desc.includes("FRIDGE") || desc.includes("REFRIGERATOR")) {
                 if (!desc.includes("PANEL") && !desc.includes("CABINET") && !desc.includes("ENCLOSURE") && !desc.includes("KIT") && !isCabinetCode) return false;
            }
            if (desc.includes("DISHWASHER")) {
                 if (!desc.includes("PANEL") && !desc.includes("RETURN") && !desc.includes("CABINET") && !desc.includes("KIT") && !isCabinetCode) return false;
            }
            if (desc.includes("RANGE") || desc.includes("COOKTOP") || desc.includes("OVEN")) {
                 if (!desc.includes("HOOD") && !desc.includes("CABINET") && !desc.includes("BASE") && !desc.includes("KIT") && !isCabinetCode) return false;
            }
            // Exclude Sinks but keep Sink Bases and Accessories
            if (desc.includes("SINK")) {
                 if (!desc.includes("BASE") && !desc.includes("CABINET") && !desc.includes("FRONT") && !desc.includes("TRAY") && !desc.includes("MAT") && !desc.includes("KIT") && !isCabinetCode) return false;
            }
            // Exclude Faucets
            if (desc.includes("FAUCET")) return false;

            // Exclude Microwaves but keep Cabinets
            if (desc.includes("MICROWAVE")) {
                if (!desc.includes("CABINET") && !desc.includes("SHELF") && !desc.includes("BASE") && !desc.includes("KIT") && !desc.includes("HOOD") && !isCabinetCode) return false;
            }
            
            // Allow Trash/Recycle explicitly (override other filters if needed, though they shouldn't conflict)
            if (desc.includes("TRASH") || desc.includes("WASTE") || desc.includes("RECYCLE") || desc.includes("BIN")) return true;

            // Allow Interior Accessories explicitly
            if (desc.includes("TRAY") || desc.includes("DIVIDER") || desc.includes("SPICE") || desc.includes("KNIFE") || desc.includes("CUTLERY") || desc.includes("ORGANIZER") || desc.includes("ROT") || desc.includes("SHELF") || desc.includes("INTERIOR") || desc.includes("DRAWER") || desc.includes("BUTT") || desc.includes("TD")) return true;
            
            // Exclude Generic Electronics/Hardware
            if (desc.includes("TELEVISION") || desc.includes(" TV ") || desc.includes("OUTLET") || desc.includes("SWITCH")) return false;
            
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

            const originalCode = item.code || "UNKNOWN";
            let normalizedCode = item.normalizedCode || originalCode;
            
            // Cleanup Code
            normalizedCode = normalizeNKBACode(normalizedCode);

            // Fallback Logic for dimensions if AI missed them
            let width = typeof item.width === 'number' ? item.width : 0;
            let height = typeof item.height === 'number' ? item.height : 0;
            let depth = typeof item.depth === 'number' ? item.depth : 0;
            
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
            items
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
                model: FAST_MODEL_NAME,
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
