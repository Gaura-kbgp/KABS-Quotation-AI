
import { calculateProjectPricing } from '../services/pricingEngine.ts';
import { CabinetItem, Manufacturer } from '../types.ts';

// Mock Catalog
const mockCatalog = {
    "B15": { "Standard": 100 },
};

// Mock Manufacturer
const mockMfg: Manufacturer = {
    id: "mfg-1",
    name: "Test Mfg",
    basePricingMultiplier: 1.0,
    tiers: [{ id: "standard", name: "Standard", multiplier: 1.0 }],
    series: [],
    options: [
        { 
            id: "opt-1", 
            name: "Finish: Painted", 
            section: "D-Finish", 
            pricingType: "percentage", 
            price: 15, // INTEGER 15, representing 15%?
            category: "Finish"
        }
    ],
    files: [],
    catalogImages: [],
    skuCount: 1,
    catalog: mockCatalog
};

// Mock Items
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
    }
];

// Mock Specs requesting the option
const specs = {
    finishColor: "Finish: Painted" // Matches option name
};

console.log("--- Starting Pricing Debug ---");

const results = calculateProjectPricing(items, mockMfg, "standard", specs as any);

results.forEach(r => {
    console.log(`Item: ${r.originalCode}`);
    console.log(`Base Price: ${r.basePrice}`);
    console.log(`Options Price: ${r.optionsPrice}`);
    console.log(`Final Unit Price: ${r.finalUnitPrice}`);
    console.log(`Total Price: ${r.totalPrice}`);
    
    r.appliedOptions?.forEach(o => {
        console.log(` - Applied Option: ${o.name} | Price: ${o.price}`);
    });
});
