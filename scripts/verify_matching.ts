
import { calculateProjectPricing } from '../services/pricingEngine';
import { CabinetItem, Manufacturer } from '../types';

// Mock Catalog
const mockCatalog = {
    "B15": { "Standard": 200 },
    "7045": { "Standard": 50 }, // Pure numeric code (e.g. Accessory)
    "FILLER": { "Standard": 30 }, // Pure alpha code
    "VDB24": { "Standard": 400 },
    "VDB24-3": { "Standard": 450 }
};

// Mock Manufacturer
const mockMfg: Manufacturer = {
    id: "mfg-1",
    name: "Test Mfg",
    basePricingMultiplier: 1.0,
    tiers: [{ id: "standard", name: "Standard", multiplier: 1.0 }],
    series: [],
    options: [],
    files: [],
    catalogImages: [],
    skuCount: 5,
    catalog: mockCatalog
};

// Mock Items from AI
const items: CabinetItem[] = [
    {
        id: "1",
        originalCode: "B15",
        normalizedCode: "B15",
        type: "Base",
        description: "Base 15",
        width: 15, height: 34.5, depth: 24,
        quantity: 1,
        modifications: []
    },
    {
        id: "2",
        originalCode: "7045", // Should match pure number
        normalizedCode: "7045",
        type: "Accessory",
        description: "Molding",
        width: 0, height: 0, depth: 0,
        quantity: 1,
        modifications: []
    },
    {
        id: "3",
        originalCode: "FILLER", // Should match pure alpha
        normalizedCode: "FILLER",
        type: "Filler",
        description: "Filler Strip",
        width: 3, height: 30, depth: 0,
        quantity: 1,
        modifications: []
    },
    {
        id: "4",
        originalCode: "VDB24AH-3", // Complex code, should match VDB24 or VDB24-3 via smart keys?
        normalizedCode: "VDB24AH-3",
        type: "Base",
        description: "Vanity",
        width: 24, height: 34.5, depth: 21,
        quantity: 1,
        modifications: []
    }
];

console.log("--- Starting Pricing Verification ---");

const results = calculateProjectPricing(items, mockMfg, "standard");

let success = true;

results.forEach(r => {
    console.log(`Item: ${r.originalCode} -> Status: ${r.source} | Price: ${r.finalUnitPrice}`);
    if (r.source === "NOT FOUND" || r.source === "Unknown") {
        console.error(`FAILED to match: ${r.originalCode}`);
        success = false;
    }
});

if (success) {
    console.log("--- ALL TESTS PASSED ---");
} else {
    console.log("--- SOME TESTS FAILED ---");
    process.exit(1);
}
