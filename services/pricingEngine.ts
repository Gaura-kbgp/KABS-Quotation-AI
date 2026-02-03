import { CabinetItem, Manufacturer, PricingLineItem, ProjectSpecs } from '../types';

// --- NEW HELPER: Standardize Code for Lookup ---
export const normalizeNKBACode = (rawCode: string): string => {
    if (!rawCode) return "";
    let code = rawCode.toUpperCase().trim();

    // 1. Fix Common OCR Symbol Errors
    code = code.replace(/\$/g, 'B'); // 3D$ -> 3DB
    code = code.replace(/€/g, 'E');
    code = code.replace(/@/g, '0');

    // Aggressive Space Removal
    code = code.replace(/\s+/g, '');

    // 2. Fix "BD1 015" -> "BD15" pattern (The '1' is often a pipe '|' or noise before a zero-padded number)
    // Target specific pattern: [Letters] + 10 + [2 Digits]
    if (/^[A-Z]+10\d{2}/.test(code)) {
         code = code.replace(/([A-Z]+)10(\d{2})/, '$1$2'); 
    }
    // Target B015 -> B15
    if (/^[A-Z]+0\d{2}/.test(code)) {
         code = code.replace(/([A-Z]+)0(\d{2})/, '$1$2');
    }

    // 3. Handle specific Manufacturer Suffixes that are directional/cosmetic only
    code = code.replace(/-?2B$/, ''); 
    code = code.replace(/-?BUTT$/, '');
    
    // NEW: Handle "DP" (Deep) or "BUT" (Butt) inside the code like W3618 X 24 DP BUT
    code = code.replace(/\s*X\s*\d+\s*DP/g, ''); // Remove explicit depth notation e.g. " X 24 DP"
    code = code.replace(/\s*BUTT?/g, ''); // Remove BUT or BUTT
    
    // NEW: Handle "1TD" (Tray Divider) or "ROT" (Roll Out Tray) embedded in code
    code = code.replace(/\d*TD/g, ''); // Remove "1TD", "TD"
    code = code.replace(/ROT/g, '');   // Remove "ROT"
    code = code.replace(/\./g, '');    // Remove dots (MW.HOOD -> MWHOOD)

    // --- NEW LOGIC: AGGRESSIVE SUFFIX STRIPPING ---
    // Handle "AH", "VH", "PH" often used for construction types
    // Support VDB27AH-3 (with dash) and VDB27AH3 (without dash)
    code = code.replace(/([0-9]+)AH(-?[0-9A-Z]+)?$/, '$1'); 
    code = code.replace(/([0-9]+)VH(-?[0-9A-Z]+)?$/, '$1'); 
    code = code.replace(/([0-9]+)PH(-?[0-9A-Z]+)?$/, '$1');

    // Handle "HD" suffix (Heavy Duty / Home Depot?) e.g. BOEHD -> BOE
    code = code.replace(/HD$/, '');

    // Handle "DHW" -> "DW" (Dishwasher?)
    if (code.startsWith('DHW')) {
        code = code.replace('DHW', 'DW');
    }

    // Remove "-L", "-R", "-LH", "-RH" ONLY if it's the very end
    // BE CAREFUL: VDB27AH-3 needs the -3. We only strip single letter directionals usually.
    if (/[0-9][LR]$/.test(code) || /[0-9]-[LR]$/.test(code)) {
        code = code.replace(/-?[LR]$/, '');
    }
    code = code.replace(/-?LH$/, '').replace(/-?RH$/, '');

    // Remove Finished End suffixes
    code = code.replace(/-?FE[LR]?$/, '');
    code = code.replace(/-?FE$/, '');

    return code;
};

// Helper to determine if an item is purely metadata/garbage
const isGarbageItem = (item: CabinetItem): boolean => {
    const text = (item.originalCode + " " + item.description).toUpperCase();
    const badWords = [
        'PAGE ', 'OF PAGE', 'SUB TOTAL', 'SUBTOTAL', 'GRAND TOTAL', 'ORDER TOTAL', 
        'TAX', 'SHIPPING', 'JOB NAME', 'PROJECT:', 'QUOTE:', 'DATE:', 'SIGNATURE',
        'CABINET SPECIFICATIONS', 'CONSTRUCTION:', 'DOOR STYLE:', 'LAYOUT'
    ];
    
    // Check for "Page X of Y" pattern
    if (/PAGE\s+\d+\s+OF\s+\d+/.test(text)) return true;

    // Check key phrases
    if (badWords.some(w => text.includes(w))) return true;

    // Check if Code is ridiculously long textual sentence
    // Relaxed limit from 20 to 50 to allow long modification strings if mistakenly put in code
    if (item.originalCode.length > 50 && item.originalCode.includes(' ')) return true;
    
    // Check if description is "Kitchen" or similar generic header
    if (item.originalCode === 'KITCHEN' || item.description === 'KITCHEN') return true;

    // Helper: Is this likely a valid cabinet code?
    const isCabinetCode = /^[A-Z0-9]{2,}/.test(item.originalCode.toUpperCase()) && 
                          !["FRIDGE", "DISHWASHER", "RANGE", "OVEN", "MICROWAVE", "SINK", "FAUCET", "PAGE"].some(bad => item.originalCode.toUpperCase().includes(bad));

    // New: Filter out obvious appliance headers if AI missed them
    // ONLY if the code itself doesn't look like a valid cabinet code (e.g. REF36)
    if (text.includes('REFRIGERATOR') && !text.includes('PANEL') && !text.includes('CABINET') && !isCabinetCode) return true;
    if (text.includes('RANGE') && !text.includes('HOOD') && !text.includes('CABINET') && !isCabinetCode) return true;

    return false;
};

// Helper to generate manufacturer-specific permutation keys based on NKBA standards
const generateSmartKeys = (item: CabinetItem): string[] => {
    const keys: string[] = [];
    const { width, height, depth, type, originalCode, normalizedCode } = item;
    
    const cleanCode = normalizeNKBACode(originalCode);
    const cleanNorm = normalizeNKBACode(normalizedCode || '');

    // Helper: Add key and its variations
    // preventRecursion flag stops infinite loops of neighbor generation
    const add = (k: string, generateNeighbors: boolean = true) => {
        if (!k) return;
        const upper = k.toUpperCase().replace(/\s+/g, ''); // Ensure no spaces
        if (!keys.includes(upper)) keys.push(upper);
        
        // Add hyphenated variations for common break points: [Letters][Numbers] -> [Letters]-[Numbers]
        // e.g. B15 -> B-15 (rare but possible) or VDB24 -> VDB-24
        if (upper.match(/^[A-Z]+\d+$/)) {
            const split = upper.match(/^([A-Z]+)(\d+)$/);
            if (split) {
                const hyphenated = `${split[1]}-${split[2]}`;
                if (!keys.includes(hyphenated)) keys.push(hyphenated);
            }
        }

        // Add variation stripping arbitrary suffixes like -W, -A, -B (often cosmetic or misread)
        // e.g. VDB24-W -> VDB24
        if (upper.includes('-')) {
            const parts = upper.split('-');
            const base = parts[0];
            const suffix = parts.slice(1).join('-'); // Rejoin rest in case of multiple dashes
            
            // If suffix is single letter, small number, or specific junk
            if (suffix.length <= 3 || suffix === 'BUTT' || suffix === '2B' || suffix.match(/^\d+$/)) {
                add(base, true); // Allow neighbors for the base stripped version
            }
        }

        // --- NEW: Handle "S" -> "SB" Mapping for Sink Bases ---
        // S30-25 -> S30 -> SB30
        if (upper.match(/^S\d+$/)) {
            add(upper.replace('S', 'SB'), true); // S30 -> SB30
        }

        // --- NEW: Handle "WDH" -> "W" / "WDC" Mapping ---
        // WDH24 -> WDC2430, W2430, etc.
        if (upper.startsWith('WDH')) {
             const nums = upper.match(/(\d+)/)?.[0];
             if (nums) {
                 // Try Wall Diagonal Corner
                 add(`WDC${nums}30`, false);
                 add(`WDC${nums}36`, false);
                 add(`WDC${nums}42`, false);
                 // Try Standard Wall
                 add(`W${nums}30`, false);
                 add(`W${nums}36`, false);
                 add(`W${nums}42`, false);
             }
        }

        // --- NEW: Handle "DHW" -> "DW" Mapping ---
        if (upper.startsWith('DHW')) {
            add(upper.replace('DHW', 'DW'), true);
        }

        // --- NEW: Handle "PDF" -> "PNL" / "F" Mapping ---
        // PDF-05 -> PNL05, F05
        if (upper.startsWith('PDF')) {
             const nums = upper.match(/(\d+)/)?.[0];
             if (nums) {
                 add(`PNL${nums}`, false);
                 add(`F${nums}`, false);
                 add(`WF${nums}`, false); // Wall Filler
                 add(`BF${nums}`, false); // Base Filler
             }
        }

        // --- NEW: Handle "OUK" -> "ACC" / "KIT" Mapping ---
        // OUK-030 -> ACC30, KIT30, or just try without prefix
        if (upper.startsWith('OUK')) {
             const nums = upper.match(/(\d+)/)?.[0];
             if (nums) {
                 add(`ACC${nums}`, false);
                 add(`KIT${nums}`, false);
             }
        }
        
        // --- NEW: Handle "CE" -> "CM" (Crown Molding) Mapping ---
        // CEHD -> CE -> CM
        if (upper.startsWith('CE')) {
            add(upper.replace('CE', 'CM'), false);
            add(upper.replace('CE', 'M'), false);
        }

        // --- NEW: Nearest Width Neighbor (Smartbrain) ---
        // Only run this if explicitly allowed (prevents infinite recursion)
        if (generateNeighbors) {
            // e.g. SB39 -> SB36, SB42
            const widthMatch = upper.match(/^([A-Z]+)(\d{2,3})$/);
            if (widthMatch) {
                const [_, prefix, wStr] = widthMatch;
                // Only apply to Bases/Vanities/Walls where width is the main number
                if (['SB', 'DB', 'B', 'VSB', 'VDB', 'W', 'BBC', 'S', 'VB', 'V'].includes(prefix)) {
                    const w = parseInt(wStr);
                    // Try +/- 3 inches (standard increments)
                    add(`${prefix}${w - 3}`, false);
                    add(`${prefix}${w + 3}`, false);
                    // Try +/- 6 inches
                    add(`${prefix}${w - 6}`, false);
                    add(`${prefix}${w + 6}`, false);
    
                    // --- NEW: Cross-Category Fallback ---
                    // If SB39 (Sink Base) fails, try B39 (Base) or VSB39 (Vanity Sink Base)
                    // Set generateNeighbors=false to prevent infinite loops (SB -> VSB -> SB)
                    if (prefix === 'SB') {
                        add(`B${w}`, false); 
                        add(`VSB${w}`, false);
                    }
                    if (prefix === 'VSB') {
                        add(`SB${w}`, false);
                        add(`VDB${w}`, false);
                    }
                }
            }
        }
    };

    // --- STRATEGY 0: FIRST TOKEN FALLBACK ---
    // e.g. "W3618 X 24 DP BUT" -> "W3618"
    // If the original code has spaces, the first part is often the real SKU.
    if (originalCode.includes(' ')) {
        const firstToken = originalCode.split(' ')[0].trim().toUpperCase();
        if (firstToken.length > 2) add(firstToken);
    }

    // --- STRATEGY 1: EXPLICIT CLEAN CODES ---
    add(originalCode);
    add(cleanCode);
    if (normalizedCode) add(normalizedCode);
    add(cleanNorm);

    // --- STRATEGY 1.5: COMMON TYPO TRANSPOSITION (The VDB/VBD Fix) ---
    // Excel sheet often has 'VBD' instead of 'VDB' or vice versa
    if (cleanCode.includes('VDB')) add(cleanCode.replace('VDB', 'VBD'));
    if (cleanCode.includes('VBD')) add(cleanCode.replace('VBD', 'VDB'));

    // --- STRATEGY 2: HANDLE COMPLEX COMBINATIONS (e.g. 3DB2136 -> 3DB21) ---
    // Regex: Start with non-digits, then digits, then 2 digits at end (height)
    const complexMatch = cleanCode.match(/^([0-9A-Z]+)(\d{2})$/);
    if (complexMatch) {
        const [_, prefix, suffix] = complexMatch;
        const sVal = parseInt(suffix);
        // If the suffix looks like a height (30-42) and likely redundant for base/vanity pricing
        if (sVal >= 30 && sVal <= 42) {
             add(prefix); 
        }
    }

    // --- STRATEGY 3: HANDLE VANITY/WALL CONFUSION (WDH -> VDB/VSB) ---
    // OCR often mistakes 'V' for 'W'. If it's WDH (Wall Diagonal), it might be VDB (Vanity Drawer Base)
    // Also user reported: WDH24-W -> Sink.
    if (cleanCode.startsWith('W') || cleanCode.startsWith('WD')) {
        // Specific fixes for common misreads or non-standard "WDH" usage for vanity
        if (cleanCode.startsWith('WDH')) {
            const remainder = cleanCode.replace('WDH', ''); // e.g. 24-W or 24
            
            // Try explicit Vanity mappings
            add(`VDB${remainder}`); // Vanity Drawer Base
            add(`VBD${remainder}`); // Typo check
            add(`VSB${remainder}`); // Vanity Sink Base
            add(`SB${remainder}`);  // Sink Base
            
            // Also try just 'B' or 'DB' if it was a misread Base
            add(`DB${remainder}`);
            add(`B${remainder}`);
        }
    }
    
    // --- STRATEGY 4: SIMILAR CABINET FALLBACK (Reduction) ---
    // User Request: "if not match to try with similar cabinet code pricing"
    // e.g. VDB27AH-3 -> VDB27-3 (Remove middle letters) -> VDB27 (Base)
    
    // 4a. Strip middle letters between digits? (e.g. VDB27AH-3 -> VDB27-3)
    const middleLetterMatch = cleanCode.match(/^([A-Z0-9]+)(\d{2})([A-Z]+)(-\d+)$/); 
    if (middleLetterMatch) {
        // [VDB][27][AH][-3] -> VDB27-3
        add(`${middleLetterMatch[1]}${middleLetterMatch[2]}${middleLetterMatch[4]}`);
    }

    // 4b. Base Fallback (Strip Suffixes entirely)
    // VDB27AH-3 -> VDB27
    const baseMatch = cleanCode.match(/^([A-Z]+)(\d+)/);
    if (baseMatch) {
        add(`${baseMatch[1]}${baseMatch[2]}`); // VDB27
        if (baseMatch[1] === 'VDB') add(`VBD${baseMatch[2]}`); // Typo check
    }

    // --- STRATEGY 5: REMOVE INTERNAL DASHES ---
    // VDB-27-AH-3 -> VDB27AH-3
    if (cleanCode.split('-').length > 2) {
         add(cleanCode.replace(/-/g, ''));
    }

    // --- STRATEGY 6: CONSTRUCTED KEYS FROM DIMENSIONS ---
    if (width > 0) {
        const w = width;
        const h = height;
        const d = depth;

        if (type === 'Wall') {
             const hVal = h || 30;
             add(`W${w}${hVal}`);
             if (d > 12) add(`W${w}${hVal}-24`);
        } else if (type === 'Base') {
             add(`B${w}`);
             add(`DB${w}`); 
             add(`SB${w}`); 
             add(`3DB${w}`);
             add(`B${w}D`);
        } else if (type === 'Tall') {
             const hVal = h || 84;
             add(`U${w}${hVal}`);
             add(`T${w}${hVal}`);
        } else if (type === 'Filler') {
             add(`F${w}`);
        } else if (type === 'Panel') {
             add(`PNL${w}`);
             add(`BP${w}`);
        }
    }
    
    // --- STRATEGY 7: DEALER VIEW FALLBACK (Aggressive Strip) ---
    // User: "work as dealer view" -> If we see "SB39AH-2B", we really just want "SB39"
    // Regex: [Letters][Numbers]... ignore the rest
    const coreMatch = cleanCode.match(/^([A-Z]+)(\d+)/);
    if (coreMatch) {
        // Just the core letters and numbers
        add(`${coreMatch[1]}${coreMatch[2]}`); 
    }

    return Array.from(new Set(keys));
};

// Helper to normalize lookups consistently with Admin ingestion
const normalizeLookup = (sku: string): string => {
    return sku.trim()
        .toUpperCase()
        .replace(/\u2013|\u2014/g, '-') // Normalize dashes
        .replace(/\s+/g, ''); // Remove spaces
}

const findCatalogPrice = (
  rawSku: string, 
  catalog: Record<string, Record<string, number>>, 
  tierId: string,
  strict: boolean = false
): { price: number; source: string; matchedSku: string } | null => {
  const cleanSku = normalizeLookup(rawSku);
  if (!cleanSku || cleanSku === "UNKNOWN") return null;

  // 1. Exact Match
  if (catalog[cleanSku]) {
     return getPriceFromItem(catalog[cleanSku], tierId, cleanSku, 'Exact');
  }
  
  // 2. Hyphen Insensitivity (Remove all dashes)
  // If cleanSku is VDB27AH-3, catalog might have VDB27AH3
  const skuNoDash = cleanSku.replace(/-/g, '');
  if (catalog[skuNoDash]) return getPriceFromItem(catalog[skuNoDash], tierId, cleanSku, 'Hyphen-Insensitive');

  // 3. Hyphen Insertion for [Letters][Numbers][Letters][Numbers] pattern
  // Target: VDB27AH3 -> VDB27AH-3
  // Regex: Ends with [Digit], preceded by [Letter]
  if (/[A-Z]\d+$/.test(cleanSku)) { 
      // check if it ends with digit group
      const suffixMatch = cleanSku.match(/(\d+)$/);
      if (suffixMatch) {
          const suffix = suffixMatch[1];
          const prefix = cleanSku.substring(0, cleanSku.length - suffix.length);
          // Only insert dash if prefix ends with letter
          if (/[A-Z]$/.test(prefix)) {
               const withDash = `${prefix}-${suffix}`;
               if (catalog[withDash]) return getPriceFromItem(catalog[withDash], tierId, cleanSku, 'Inserted-Hyphen (VDB27AH-3)');
          }
      }
  }

  if (strict) return null;

  // 4. Neighbor Search (Height +/- 2 inches)
  const wallMatch = cleanSku.match(/^(W\d{2})(\d{2})([A-Z]*)$/);
  if (wallMatch) {
      const [_, prefix, hStr, suffix] = wallMatch;
      const h = parseInt(hStr);
      const neighbors = [h+1, h-1, h+2, h-2];
      for (const nh of neighbors) {
          const candidate = `${prefix}${nh}${suffix}`;
          if (catalog[candidate]) return getPriceFromItem(catalog[candidate], tierId, candidate, `Neighbor (Matched ${candidate})`);
          if (suffix) {
              const simpleCandidate = `${prefix}${nh}`;
              if (catalog[simpleCandidate]) return getPriceFromItem(catalog[simpleCandidate], tierId, simpleCandidate, `Neighbor (Matched ${simpleCandidate})`);
          }
      }
  }

  // 5. Fuzzy Suffix Stripping (Iterative)
  // Limit to reasonable length to avoid matching "B" from "B15"
  for (let i = cleanSku.length - 1; i > 2; i--) {
      const sub = cleanSku.substring(0, i);
      if (catalog[sub]) {
          const strippedPart = cleanSku.substring(i);
          return getPriceFromItem(catalog[sub], tierId, sub, `Similar (Stripped ${strippedPart})`);
      }
  }

  // 6. Regex Core Extraction (Letters+Numbers)
  const heuristic = cleanSku.match(/^([A-Z]{1,4}\d{2,5})/);
  if (heuristic) {
      const core = heuristic[0];
      if (catalog[core]) return getPriceFromItem(catalog[core], tierId, core, 'Core Extraction');
  }

  return null;
};

// Helper to extract specific tier price from item object
const getPriceFromItem = (item: Record<string, number>, tierId: string, sku: string, method: string) => {
      if (item[tierId] !== undefined) return { price: item[tierId], source: `Catalog (${method} Tier)`, matchedSku: sku };
      
      const fuzzyTier = Object.keys(item).find(k => k.toLowerCase().includes(tierId.toLowerCase()) || tierId.toLowerCase().includes(k.toLowerCase()));
      if (fuzzyTier) return { price: item[fuzzyTier], source: `Catalog (${method} Fuzzy '${fuzzyTier}')`, matchedSku: sku };
      
      const firstKey = Object.keys(item)[0];
      if (firstKey) return { price: item[firstKey], source: `Catalog (${method} Fallback '${firstKey}')`, matchedSku: sku };
      
      return null;
}

export const calculateProjectPricing = (
  items: CabinetItem[],
  manufacturer: Manufacturer,
  tierId: string, 
  specs?: ProjectSpecs
): PricingLineItem[] => {
  const tier = manufacturer.tiers.find(t => t.id === tierId) || manufacturer.tiers[0];
  const tierNameForLookup = tier ? tier.name : (specs?.priceGroup || 'Standard');
  
  // 1. Get Checkbox Options
  const checkboxOptions = manufacturer.options?.filter(opt => !!specs?.selectedOptions?.[opt.id]) || [];

  // 2. Get Dropdown Options (Match by Name)
  // We collect the string values from the specs that might correspond to billable options
  const potentialOptionNames = [
      specs?.drawerBox,
      specs?.hingeType, 
      specs?.woodSpecies,
      specs?.finishColor,
      specs?.glaze,
      specs?.finishOption1,
      specs?.finishOption2,
      specs?.printedEndOption,
      specs?.wallDoorOption,
      specs?.baseDoorOption
  ].filter(val => val && val !== 'None' && val !== 'Standard' && val !== 'No'); // Filter out defaults

  const dropdownOptions = manufacturer.options?.filter(opt => 
      potentialOptionNames.some(name => {
          if (!name) return false;
          // Exact match
          if (name === opt.name) return true;
          // Fuzzy match: Check if one contains the other (case-insensitive)
          const n = name.toLowerCase();
          const o = opt.name.toLowerCase();
          return n.includes(o) || o.includes(n);
      })
  ) || [];

  // Merge options (avoid duplicates if an option is both checked and selected)
  // Deduplicate by ID and Name to prevent explosion if multiple identical options exist
  const activeOptions = [...checkboxOptions];
  dropdownOptions.forEach(opt => {
      if (!activeOptions.find(o => o.id === opt.id || o.name === opt.name)) {
          activeOptions.push(opt);
      }
  });

  const results: PricingLineItem[] = [];

  items.forEach(item => {
    // 0. Garbage Check
    if (isGarbageItem(item)) return; // Skip this item entirely

    let basePrice = 0;
    let source = 'Unknown';
    let optionsPrice = 0;
    let matchedSku = item.originalCode;
    const appliedOptionsLog: { name: string; price: number; sourceSection?: string }[] = [];

    // 1. MODIFICATIONS
    if (item.modifications && item.modifications.length > 0) {
        item.modifications.forEach(mod => {
            optionsPrice += (mod.price || 0);
            appliedOptionsLog.push({ name: mod.description, price: mod.price || 0, sourceSection: 'PDF Extraction' });
        });
    }

    // 2. MANUFACTURER OPTIONS
    activeOptions.forEach(opt => {
        let applies = true;
        if (opt.section === 'E-Drawer' && item.type !== 'Base') applies = false;
        if (opt.section === 'F-Hinge' && item.type === 'Filler') applies = false;
        if (opt.section === 'F-Hinge' && item.type === 'Panel') applies = false;
        if (opt.name.toLowerCase().includes('wall') && item.type !== 'Wall') applies = false;
        if (opt.name.toLowerCase().includes('base') && item.type !== 'Base') applies = false;

        if (applies) {
            let addPrice = 0;
            if (opt.pricingType === 'fixed') addPrice = opt.price;
            if (addPrice > 0) {
                optionsPrice += addPrice;
                appliedOptionsLog.push({ name: opt.name, price: addPrice, sourceSection: opt.section });
            }
        }
    });

    // 3. BASE PRICE
    let match: any = null;
    const smartKeys = generateSmartKeys(item);
    
    // Pass 1: Try exact/fuzzy match on ORIGINAL code
    match = findCatalogPrice(item.originalCode, manufacturer.catalog || {}, tierNameForLookup, true);

    // Pass 2: Try smart keys STRICTLY
    if (!match) {
        for (const key of smartKeys) {
            match = findCatalogPrice(key, manufacturer.catalog || {}, tierNameForLookup, true);
            if (match) {
                match.source = `Catalog (Similar '${key}')`;
                break;
            }
        }
    }
    
    // Pass 3: Fallback to Fuzzy/Loose matching on Original Code
    if (!match) {
        match = findCatalogPrice(item.originalCode, manufacturer.catalog || {}, tierNameForLookup, false);
    }
    
    if (match) {
        basePrice = match.price;
        source = match.source;
        matchedSku = match.matchedSku;
    } else if (item.extractedPrice && item.extractedPrice > 0) {
        basePrice = item.extractedPrice;
        source = 'Extracted from PDF';
    } else {
        basePrice = 0;
        source = 'NOT FOUND';
    }

    // 4. PERCENTAGE OPTIONS
    activeOptions.forEach(opt => {
         if (opt.section === 'D-Finish' || opt.pricingType === 'percentage') {
             // Safety: Normalize percentage. If > 1 (e.g. 15), treat as 15% (0.15). 
             // Exception: If > 4 (400%), it's likely an error, but we'll cap or assume integer pct.
             let pct = opt.price;
             if (pct > 1) pct = pct / 100;
             
             const addPrice = basePrice * pct; 
             optionsPrice += addPrice;
             appliedOptionsLog.push({ name: `${opt.name} (${(pct*100).toFixed(0)}%)`, price: addPrice, sourceSection: opt.section });
         }
    });

    const adjustedBase = basePrice * manufacturer.basePricingMultiplier;
    const tierMultiplier = tier ? tier.multiplier : 1.0;
    const finalUnitPrice = (adjustedBase + optionsPrice) * tierMultiplier;
    const totalPrice = finalUnitPrice * item.quantity;

    results.push({
      ...item,
      normalizedCode: matchedSku,
      basePrice: Math.round(adjustedBase),
      optionsPrice: Math.round(optionsPrice),
      tierMultiplier,
      finalUnitPrice: Math.round(finalUnitPrice),
      totalPrice: Math.round(totalPrice),
      tierName: tier ? tier.name : 'Standard',
      source,
      appliedOptions: appliedOptionsLog
    });
  });

  // Sort Results: Type Priority then Code
  const typePriority: Record<string, number> = {
      'Base': 1,
      'Wall': 2,
      'Tall': 3,
      'Panel': 4,
      'Filler': 5,
      'Accessory': 6,
      'Modification': 7
  };

  return results.sort((a, b) => {
      // 1. Sort by Type
      const typeA = typePriority[a.type || 'Base'] || 99;
      const typeB = typePriority[b.type || 'Base'] || 99;
      if (typeA !== typeB) return typeA - typeB;

      // 2. Sort by Code (Alpha then Numeric)
      return a.originalCode.localeCompare(b.originalCode, undefined, { numeric: true, sensitivity: 'base' });
  });
};