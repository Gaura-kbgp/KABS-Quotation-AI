import { CabinetItem, Manufacturer, PricingLineItem, ProjectSpecs } from '../types';

// --- NEW HELPER: Standardize Code for Lookup ---
export const normalizeNKBACode = (rawCode: string): string => {
    if (!rawCode) return "";
    let code = rawCode.toUpperCase().trim();

    // 1. Fix Common OCR Symbol Errors
    code = code.replace(/\$/g, 'B'); // 3D$ -> 3DB
    code = code.replace(/€/g, 'E');
    code = code.replace(/@/g, '0');

    // Aggressive Space Removal - MODIFIED to preserve suffixes like " BUTT"
    // We want to remove spaces inside the code (e.g. "SB 33" -> "SB33")
    // But keep space before known text suffixes if needed?
    // Actually, most catalogs use "SB33" or "SB33BUTT". If the catalog has "SB33 BUTT", we need to keep space.
    // Let's normalize multiple spaces to single space first.
    code = code.replace(/\s+/g, ' ').trim();
    
    // Remove space between Letters and Numbers (e.g. "SB 33" -> "SB33")
    code = code.replace(/([A-Z])\s+(\d)/g, '$1$2');

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
    // code = code.replace(/-?BUTT$/, ''); <-- DISABLED: User needs BUTT
    
    // NEW: Handle (L) or (R) in parenthesis
    code = code.replace(/\([LR]\)$/, '');

    // NEW: Handle "DP" (Deep) or "BUT" (Butt) inside the code like W3618 X 24 DP BUT
    code = code.replace(/\s*X\s*\d+\s*DP/g, ''); // Remove explicit depth notation e.g. " X 24 DP"
    // code = code.replace(/\s*BUTT?/g, ''); // Remove BUT or BUTT <-- DISABLED: User needs BUTT for SKU matching
    
    // NEW: Handle "1TD" (Tray Divider) or "ROT" (Roll Out Tray) embedded in code
    code = code.replace(/\d*TD/g, ''); // Remove "1TD", "TD"
    code = code.replace(/ROT/g, '');   // Remove "ROT"
    
    // Fix: Only remove dots if NOT part of a decimal number (e.g. keep 1.5, remove MW.HOOD)
    // We remove dot if it is NOT followed by a digit, OR if it is not preceded by a digit
    // But simplest is: replace dot if it's not between two digits
    code = code.replace(/(?<!\d)\./g, '').replace(/\.(?!\d)/g, '');    

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
const generateSmartKeys = (item: CabinetItem): { exact: string[], similar: string[] } => {
    const exactKeys: string[] = [];
    const similarKeys: string[] = [];
    const processed = new Set<string>();

    const { width, height, depth, type, originalCode, normalizedCode } = item;
    
    const cleanCode = normalizeNKBACode(originalCode);
    const cleanNorm = normalizeNKBACode(normalizedCode || '');

    // Helper: Add key and its variations
    const add = (k: string, category: 'exact' | 'similar' = 'exact', allowNeighbors: boolean = true) => {
        if (!k) return;
        const upper = k.toUpperCase().replace(/\s+/g, ''); // Ensure no spaces
        
        // Prevent Duplicates
        if (processed.has(upper)) return;
        processed.add(upper);
        
        if (category === 'exact') exactKeys.push(upper);
        else similarKeys.push(upper);
        
        // Add hyphenated variations: [Letters][Numbers] -> [Letters]-[Numbers]
        if (upper.match(/^[A-Z]+\d+$/)) {
            const split = upper.match(/^([A-Z]+)(\d+)$/);
            if (split) {
                const hyphenated = `${split[1]}-${split[2]}`;
                if (!processed.has(hyphenated)) {
                    processed.add(hyphenated);
                    if (category === 'exact') exactKeys.push(hyphenated);
                    else similarKeys.push(hyphenated);
                }
            }
        }

        // Variation: Strip arbitrary suffixes like -W, -A, -B (High confidence normalization = Exact)
        if (upper.includes('-')) {
            const parts = upper.split('-');
            const base = parts[0];
            const suffix = parts.slice(1).join('-'); 
            
            // If suffix is single letter, small number, or specific junk
            if (suffix.length <= 3 || suffix === 'BUTT' || suffix === '2B' || suffix.match(/^\d+$/)) {
                // If we strip a cosmetic suffix, it's still considered an "Exact" intent match
                add(base, category, allowNeighbors); 
            }
        }

        // Neighbor Generation (Always classified as SIMILAR)
        if (allowNeighbors) {
            // e.g. SB39 -> SB36, SB42
            const widthMatch = upper.match(/^([A-Z]+)(\d{2,3})$/);
            if (widthMatch) {
                const [_, prefix, wStr] = widthMatch;
                if (['SB', 'DB', 'B', 'VSB', 'VDB', 'W', 'BBC', 'S', 'VB', 'V'].includes(prefix)) {
                    const w = parseInt(wStr);
                    // Try +/- 3 inches
                    add(`${prefix}${w - 3}`, 'similar', false);
                    add(`${prefix}${w + 3}`, 'similar', false);
                    // Try +/- 6 inches
                    add(`${prefix}${w - 6}`, 'similar', false);
                    add(`${prefix}${w + 6}`, 'similar', false);
    
                    // Cross-Category Fallback
                    if (prefix === 'SB') {
                        add(`B${w}`, 'similar', false); 
                        add(`VSB${w}`, 'similar', false);
                    }
                    if (prefix === 'VSB') {
                        add(`SB${w}`, 'similar', false);
                        add(`VDB${w}`, 'similar', false);
                    }
                }
            }
        }
    };

    // --- STRATEGY 0: FIRST TOKEN FALLBACK (Exact) ---
    if (originalCode.includes(' ')) {
        const firstToken = originalCode.split(' ')[0].trim().toUpperCase();
        if (firstToken.length > 2) add(firstToken, 'exact', true);
    }

    // --- STRATEGY 1: EXPLICIT CLEAN CODES (Exact) ---
    add(originalCode, 'exact', true);
    add(cleanCode, 'exact', true);
    if (normalizedCode) add(normalizedCode, 'exact', true);
    add(cleanNorm, 'exact', true);

    // --- STRATEGY 1.5: COMMON TYPO TRANSPOSITION (Exact/Correction) ---
    if (cleanCode.includes('VDB')) add(cleanCode.replace('VDB', 'VBD'), 'exact', true);
    if (cleanCode.includes('VBD')) add(cleanCode.replace('VBD', 'VDB'), 'exact', true);

    // --- STRATEGY 2: HANDLE COMPLEX COMBINATIONS (Exact) ---
    // 3DB2136 -> 3DB21 (If 36 is height)
    const complexMatch = cleanCode.match(/^([0-9A-Z]+)(\d{2})$/);
    if (complexMatch) {
        const [_, prefix, suffix] = complexMatch;
        const sVal = parseInt(suffix);
        if (sVal >= 30 && sVal <= 42) {
             add(prefix, 'exact', true); 
        }
    }

    // --- STRATEGY 3: HANDLE VANITY/WALL CONFUSION (Similar/Correction) ---
    if (cleanCode.startsWith('W') || cleanCode.startsWith('WD')) {
        if (cleanCode.startsWith('WDH')) {
            const remainder = cleanCode.replace('WDH', ''); 
            add(`VDB${remainder}`, 'similar', false);
            add(`VSB${remainder}`, 'similar', false);
            add(`SB${remainder}`, 'similar', false);
            add(`DB${remainder}`, 'similar', false);
            add(`B${remainder}`, 'similar', false);
        }
    }
    
    // --- STRATEGY 4: SIMILAR CABINET FALLBACK (Similar) ---
    // 4a. Strip middle letters: VDB27AH-3 -> VDB27-3
    const middleLetterMatch = cleanCode.match(/^([A-Z0-9]+)(\d{2})([A-Z]+)(-\d+)$/); 
    if (middleLetterMatch) {
        add(`${middleLetterMatch[1]}${middleLetterMatch[2]}${middleLetterMatch[4]}`, 'similar', true);
    }

    // 4b. Base Fallback: VDB27AH-3 -> VDB27
    const baseMatch = cleanCode.match(/^([A-Z]+)(\d+)/);
    if (baseMatch) {
        add(`${baseMatch[1]}${baseMatch[2]}`, 'similar', true);
    }

    // --- STRATEGY 5: REMOVE INTERNAL DASHES (Exact) ---
    if (cleanCode.split('-').length > 2) {
         add(cleanCode.replace(/-/g, ''), 'exact', true);
    }

    // --- STRATEGY 6: CONSTRUCTED KEYS FROM DIMENSIONS (Exact/High Confidence) ---
    // If we have dimensions, these are often MORE reliable than the OCR code.
    if (width > 0) {
        const w = width;
        const h = height;
        const d = depth;

        if (type === 'Wall') {
             const hVal = h || 30;
             add(`W${w}${hVal}`, 'exact', false);
             if (d > 12) add(`W${w}${hVal}-24`, 'exact', false);
        } else if (type === 'Base') {
             add(`B${w}`, 'exact', false);
             add(`DB${w}`, 'exact', false); 
             add(`SB${w}`, 'exact', false); 
             add(`3DB${w}`, 'exact', false);
             add(`B${w}D`, 'exact', false);
        } else if (type === 'Tall') {
             const hVal = h || 84;
             add(`U${w}${hVal}`, 'exact', false);
             add(`T${w}${hVal}`, 'exact', false);
        } else if (type === 'Filler') {
             add(`F${w}`, 'exact', false);
        } else if (type === 'Panel') {
             add(`PNL${w}`, 'exact', false);
             add(`BP${w}`, 'exact', false);
        }
    }
    
    // --- STRATEGY 7: SPECIFIC ABBREVIATION EXPANSION (Similar/Expansion) ---
    // These are interpretations of abbreviations, so they go to 'similar' or 'exact' depending on confidence.
    // Since "TEP" is not a valid SKU, these are the ONLY way to match, so they are effectively exact replacements.
    
    // S -> SB
    if (cleanCode.match(/^S\d+$/)) add(cleanCode.replace('S', 'SB'), 'exact', true);
    
    // WDH -> WDC
    if (cleanCode.startsWith('WDH')) {
         const nums = cleanCode.match(/(\d+)/)?.[0];
         if (nums) {
             add(`WDC${nums}30`, 'similar', false);
             add(`W${nums}30`, 'similar', false);
         }
    }

    // PDF -> PNL
    if (cleanCode.startsWith('PDF')) {
         const nums = cleanCode.match(/(\d+)/)?.[0];
         if (nums) {
             add(`PNL${nums}`, 'exact', false);
             add(`F${nums}`, 'exact', false);
         }
    }

    // OUK -> ACC
    if (cleanCode.startsWith('OUK')) {
         const nums = cleanCode.match(/(\d+)/)?.[0];
         if (nums) {
             add(`ACC${nums}`, 'similar', false);
             add(`KIT${nums}`, 'similar', false);
         }
    }
    
    // CE -> CM
    if (cleanCode.startsWith('CE')) {
        add(cleanCode.replace('CE', 'CM'), 'exact', false);
    }

    // TEP/BEP/REP
    if (cleanCode.startsWith('TEP')) {
        add('TEP2484', 'exact', false);
        add('TEP96', 'exact', false);
    }
    if (cleanCode.startsWith('BEP')) {
        add('BEP24', 'exact', false);
    }
    if (cleanCode.startsWith('REP')) {
        add('REP2496', 'exact', false);
        add('REP96', 'exact', false);
    }
    
    // Fillers
    if (cleanCode.startsWith('BF')) {
         const w = cleanCode.replace('BF', '');
         add(`F${w}`, 'exact', false);
         add('F3', 'similar', false); 
    }
    if (cleanCode.startsWith('WF')) {
         const w = cleanCode.replace('WF', '');
         add(`F${w}`, 'exact', false);
         add('F3', 'similar', false);
    }
    
    // Generic Fillers
    if (cleanCode.startsWith('F') && !cleanCode.startsWith('FE')) {
        const w = cleanCode.replace('F', '');
        add(`BF${w}`, 'similar', false);
        add(`WF${w}`, 'similar', false);
    }

    // --- STRATEGY 8: FUZZY NEIGHBOR MATCHING (Aggressive) ---
    // Already handled by allowNeighbors=true in Strategy 1/1.5/2
    // But we can add explicit global neighbors for the clean code here if not already added
    const core = cleanCode.match(/^([A-Z]+)(\d+)/);
    if (core) {
        const prefix = core[1];
        const numPart = parseInt(core[2]);
        
        // Explicit standard sizes fallback
        if (numPart < 100) {
            [9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48].forEach(std => {
                if (Math.abs(numPart - std) <= 2) add(`${prefix}${std}`, 'similar', false);
            });
        }
    }

    return { exact: exactKeys, similar: similarKeys };
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
  const skuNoDash = cleanSku.replace(/-/g, '');
  if (catalog[skuNoDash]) return getPriceFromItem(catalog[skuNoDash], tierId, cleanSku, 'Hyphen-Insensitive');

  // 3. Hyphen Insertion
  if (/[A-Z]\d+$/.test(cleanSku)) { 
      const suffixMatch = cleanSku.match(/(\d+)$/);
      if (suffixMatch) {
          const suffix = suffixMatch[1];
          const prefix = cleanSku.substring(0, cleanSku.length - suffix.length);
          if (/[A-Z]$/.test(prefix)) {
               const withDash = `${prefix}-${suffix}`;
               if (catalog[withDash]) return getPriceFromItem(catalog[withDash], tierId, cleanSku, 'Inserted-Hyphen');
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

  // 5. Fuzzy Suffix Stripping
  for (let i = cleanSku.length - 1; i > 2; i--) {
      const sub = cleanSku.substring(0, i);
      if (catalog[sub]) {
          const strippedPart = cleanSku.substring(i);
          return getPriceFromItem(catalog[sub], tierId, sub, `Similar (Stripped ${strippedPart})`);
      }
  }

  // 6. Regex Core Extraction
  const heuristic = cleanSku.match(/^([A-Z]{1,4}\d{2,5})/);
  if (heuristic) {
      const core = heuristic[0];
      if (catalog[core]) return getPriceFromItem(catalog[core], tierId, core, 'Core Extraction');
  }

  return null;
};

// Helper to extract specific tier price from item object
const getPriceFromItem = (item: Record<string, number>, tierId: string, sku: string, method: string) => {
      // 1. Direct Tier Match
      if (item[tierId] !== undefined) return { price: item[tierId], source: `Catalog (${method} Tier)`, matchedSku: sku };
      
      // 2. Fuzzy Tier Match (Case insensitive)
      const fuzzyTier = Object.keys(item).find(k => k.toLowerCase().includes(tierId.toLowerCase()) || tierId.toLowerCase().includes(k.toLowerCase()));
      if (fuzzyTier) return { price: item[fuzzyTier], source: `Catalog (${method} Fuzzy '${fuzzyTier}')`, matchedSku: sku };
      
      // 3. Single Column Fallback (Critical for simple price lists)
      // If the item only has ONE price column, use it regardless of the requested tier name.
      // This solves the issue where user selects "Midland" but Excel just has "Price".
      const keys = Object.keys(item);
      if (keys.length === 1) {
          return { price: item[keys[0]], source: `Catalog (${method} Fallback '${keys[0]}')`, matchedSku: sku };
      }

      // 4. "Price" or "List Price" generic fallback
      const genericKey = keys.find(k => k.toLowerCase().includes('price') || k.toLowerCase().includes('list'));
      if (genericKey) return { price: item[genericKey], source: `Catalog (${method} Generic '${genericKey}')`, matchedSku: sku };

      // 5. Last Resort: First Key
      if (keys.length > 0) return { price: item[keys[0]], source: `Catalog (${method} Blind Fallback '${keys[0]}')`, matchedSku: sku };
      
      return null;
}

export const calculateProjectPricing = (
  items: CabinetItem[],
  manufacturer: Manufacturer,
  tierId: string, 
  specs?: ProjectSpecs,
  financials?: any, // Using any temporarily to avoid circular deps if types aren't fully propagated, but practically it's ProjectFinancials
  roomSpecs?: Record<string, ProjectSpecs> // NEW: Room Specific Specs
): PricingLineItem[] => {
  const globalTier = manufacturer.tiers.find(t => t.id === tierId) || manufacturer.tiers[0];
  const globalTierName = globalTier ? globalTier.name : (specs?.priceGroup || 'Standard');
  
  // Pre-calculate Global Options
  const getOptionsForSpecs = (s?: ProjectSpecs) => {
      const checkboxOptions = manufacturer.options?.filter(opt => !!s?.selectedOptions?.[opt.id]) || [];
      const potentialOptionNames = [
          s?.drawerBox, s?.hingeType, s?.woodSpecies, s?.finishColor, s?.glaze,
          s?.finishOption1, s?.finishOption2, s?.printedEndOption,
          s?.wallDoorOption, s?.baseDoorOption,
          ...Object.values(s?.dynamicSelections || {})
      ].filter(val => val && val !== 'None' && val !== 'Standard' && val !== 'No'); 
      
      const dropdownOptions = manufacturer.options?.filter(opt => 
          potentialOptionNames.some(name => name && name.toLowerCase() === opt.name.toLowerCase())
      ) || [];
      
      return [...checkboxOptions, ...dropdownOptions.filter(d => !checkboxOptions.find(c => c.id === d.id))];
  };

  const globalOptions = getOptionsForSpecs(specs);

  const results: PricingLineItem[] = [];

  items.forEach(item => {
    // 0. Garbage Check
    if (isGarbageItem(item)) return;

    // --- DETERMINE ROOM CONTEXT ---
    let effectiveSpecs = specs;
    let effectiveTierName = globalTierName;
    let activeOptions = globalOptions;

    // Check for Room Override
    if (item.room && roomSpecs && roomSpecs[item.room]) {
        effectiveSpecs = { ...specs, ...roomSpecs[item.room] }; // Merge global with room (room wins)
        // Recalculate options for this room
        activeOptions = getOptionsForSpecs(effectiveSpecs);
        
        // Determine Tier for this room (Price Group)
        if (effectiveSpecs.priceGroup) {
            effectiveTierName = effectiveSpecs.priceGroup;
        }
    }

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
        if (opt.name.length > 50 && opt.price === 0) applies = false;

        if (applies) {
            let addPrice = 0;
            if (opt.pricingType === 'fixed') addPrice = opt.price;
            
            if (addPrice > 0 || (opt.price === 0 && opt.name.length < 50)) {
                optionsPrice += addPrice;
                appliedOptionsLog.push({ name: opt.name, price: addPrice, sourceSection: opt.section });
            }
        }
    });

    // 3. BASE PRICE LOOKUP
    let match: any = null;
    const { exact, similar } = generateSmartKeys(item);
    
    // Pass 1: Try exact/fuzzy match on ORIGINAL code
    match = findCatalogPrice(item.originalCode, manufacturer.catalog || {}, effectiveTierName, true);

    // Pass 2: Try EXACT keys STRICTLY
    if (!match) {
        for (const key of exact) {
            match = findCatalogPrice(key, manufacturer.catalog || {}, effectiveTierName, true);
            if (match) {
                match.source = `Catalog (Exact Match '${key}')`;
                break;
            }
        }
    }
    
    // Pass 3: Try SIMILAR keys STRICTLY
    if (!match) {
        for (const key of similar) {
            match = findCatalogPrice(key, manufacturer.catalog || {}, effectiveTierName, true);
            if (match) {
                match.source = `Catalog (Similar Match '${key}')`;
                break;
            }
        }
    }
    
    // Pass 4: Fallback to Fuzzy/Loose matching on Original Code
    if (!match) {
        match = findCatalogPrice(item.originalCode, manufacturer.catalog || {}, effectiveTierName, false);
    }

    // Pass 5: GLOBAL CATALOG SEARCH (The "Full XLSM" Fallback)
    // If we still haven't found it, iterate the entire catalog keys to find a partial match.
    // This addresses the user request: "if not match then try to match with full xlsm"
    if (!match) {
        const catalogKeys = Object.keys(manufacturer.catalog || {});
        // 5a. Look for catalog key that STARTS WITH the normalized code (e.g. SKU="B15", Catalog="B15-L")
        // We sort by length ascending to find the shortest (simplest) match first
        const cleanSku = normalizeLookup(item.originalCode);
        if (cleanSku && cleanSku !== "UNKNOWN") {
            const potentialMatch = catalogKeys.find(k => {
                 const normK = normalizeLookup(k);
                 return normK.startsWith(cleanSku) && normK.length <= cleanSku.length + 3; // Allow up to 3 extra chars (e.g. -L, -R)
            });
            
            if (potentialMatch) {
                match = getPriceFromItem(manufacturer.catalog![potentialMatch], effectiveTierName, potentialMatch, `Catalog (Global Prefix Match '${potentialMatch}')`);
            }
        }
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
         if (opt.pricingType === 'percentage') {
             let pct = opt.price;
             if (pct > 1) pct = pct / 100;
             const addPrice = basePrice * pct; 
             if (opt.name.length > 50 && addPrice === 0) return;

             optionsPrice += addPrice;
             appliedOptionsLog.push({ name: `${opt.name} (${(pct*100).toFixed(0)}%)`, price: addPrice, sourceSection: opt.section });
         }
    });

    // --- NEW COST & PRICING LOGIC ---
    // 1. Determine Factor (Room Specific or Global)
    const globalFactor = financials?.pricingFactor || manufacturer.basePricingMultiplier || 1.0;
    const roomFactor = (item.room && financials?.roomFactors?.[item.room]) 
                        ? financials.roomFactors[item.room] 
                        : globalFactor;

    // 2. Calculate Cost
    // List Price = (Base + Options) * Tier Multiplier (if tier has built-in factor, usually 1 for raw catalog)
    // Actually, usually Catalog Price IS List Price.
    const totalListPrice = (basePrice + optionsPrice);
    
    // Cost = List * Factor
    const unitCost = totalListPrice * roomFactor;

    // 3. Determine Margin
    // Check for specific Series/Level margin override
    // For now, simple global margin or category based
    let margin = financials?.globalMargin || 0;
    if (financials?.categoryMargins) {
         // Try to match by Tier Name or Door Style
         const tierName = effectiveTierName || 'Standard';
         if (financials.categoryMargins[tierName]) {
             margin = financials.categoryMargins[tierName];
         }
    }
    
    // Normalize Margin (e.g. 35 -> 0.35)
    const marginDecimal = margin > 1 ? margin / 100 : margin;

    // 4. Calculate Sell Price
    // Sell = Cost / (1 - Margin)
    let unitSell = 0;
    if (marginDecimal >= 1) {
        unitSell = unitCost; // Prevent division by zero or negative
    } else {
        unitSell = unitCost / (1 - marginDecimal);
    }

    const totalPrice = unitSell * item.quantity;

    results.push({
      ...item,
      normalizedCode: matchedSku,
      basePrice: Math.round(basePrice),
      optionsPrice: Math.round(optionsPrice),
      tierMultiplier: 1, // Deprecated in favor of Factor logic, but kept for types
      
      unitCost: Number(unitCost.toFixed(2)),
      finalUnitPrice: Number(unitSell.toFixed(2)),
      totalPrice: Number(totalPrice.toFixed(2)),
      
      pricingFactor: roomFactor,
      margin: marginDecimal * 100,
      
      tierName: effectiveTierName || 'Standard',
      source,
      appliedOptions: appliedOptionsLog
    });
  });

  // Sort Results
  const typePriority: Record<string, number> = {
      'Base': 1, 'Wall': 2, 'Tall': 3, 'Panel': 4, 'Filler': 5, 'Accessory': 6, 'Modification': 7
  };

  return results.sort((a, b) => {
      const typeA = typePriority[a.type || 'Base'] || 99;
      const typeB = typePriority[b.type || 'Base'] || 99;
      if (typeA !== typeB) return typeA - typeB;
      return a.originalCode.localeCompare(b.originalCode, undefined, { numeric: true, sensitivity: 'base' });
  });
};