

export type CabinetType = 'Base' | 'Wall' | 'Tall' | 'Vanity' | 'Panel' | 'Filler' | 'Accessory' | 'Modification' | 'Appliance' | 'Hardware' | 'Finishing';

export interface CabinetModification {
  description: string;
  price: number;
}

export interface CabinetItem {
  id: string;
  originalCode: string;
  normalizedCode?: string;
  type: CabinetType;
  description: string;
  width: number;
  height: number;
  depth: number;
  quantity: number;
  notes?: string;
  room?: string; // NEW: Room Name (e.g. "Kitchen", "Master Bath")
  extractedPrice?: number; // Price found in the PDF/Image
  sourcePage?: number; // Page number where the item was found
  isManual?: boolean; // Flag for manually added items
  modifications?: CabinetModification[]; // Add-ons like Skins, Depth changes
}

export interface PricingTier {
  id: string;
  name: string; // Maps to Excel Column Headers (e.g. "Oak", "Painted", "Lvl 1")
  multiplier: number; 
  collection?: string; // NEW: Grouping (e.g. "Elite", "Premium")
}

// LOGICAL WORKBOOK SECTIONS
export type WorkbookSection = 
  | 'A-Context' 
  | 'B-Series' 
  | 'C-Door' 
  | 'D-Finish' 
  | 'E-Drawer' 
  | 'F-Hinge' 
  | 'G-Construction' 
  | 'H-WallPrice' 
  | 'I-BasePrice' 
  | 'J-TallPrice' 
  | 'K-Accessory' 
  | 'L-Summary'
  | 'M-PrintedEnds' // NEW: For the specific request
  | 'Unknown';

export interface ManufacturerOption {
  id: string;
  name: string;
  category: 'Collection' | 'Series' | 'Door' | 'DoorStyle' | 'Wood' | 'Finish' | 'Glaze' | 'Paint' | 'Stain' | 'Drawer' | 'Hinge' | 'Construction' | 'PrintedEnd' | 'Molding' | 'Accents' | 'Decorative' | 'Upgrade' | 'Other';
  section: WorkbookSection; // Audit trail for where this option was found
  pricingType: 'fixed' | 'percentage' | 'included';
  price: number; // Dollar amount or Decimal percentage (0.10 for 10%)
  description?: string;
  sourceSheet?: string; 
  collection?: string; // NEW: Parent Collection (e.g. "Elite", "Premium")
  availability?: string; // "Yes", "No", or specific wood types like "Maple"
}

export interface CabinetSeries {
  id: string;
  name: string; 
  description?: string;
}

export interface ManufacturerFile {
  id: string;
  name: string;
  type: 'pricing' | 'spec';
  uploadDate: string;
  size: number;
  data?: string; 
  url?: string;
}

export interface Manufacturer {
  id: string;
  name: string;
  logoUrl?: string;
  basePricingMultiplier: number;
  tiers: PricingTier[];
  series: CabinetSeries[]; 
  options: ManufacturerOption[]; 
  // Catalog maps SKU to a dictionary of prices per Tier ID/Name
  catalog?: Record<string, Record<string, number>>; 
  catalogImages?: string[]; 
  skuCount?: number; 
  dealerName?: string; // NEW: Associate manufacturer with a dealer
  files: ManufacturerFile[];
}

export interface PricingLineItem extends CabinetItem {
  basePrice: number; // This is now treated as LIST PRICE
  optionsPrice: number; // List Price of options
  tierMultiplier: number; // Factor derived from Tier (if any)
  
  // Cost Side
  unitCost: number; // (Base + Options) * Factor
  
  // Sell Side
  finalUnitPrice: number; // unitCost / (1 - Margin)
  totalPrice: number; // finalUnitPrice * Quantity
  
  tierName: string;
  source: string;
  appliedOptions: { name: string; price: number; sourceSection?: string }[]; 
  
  // Audit
  pricingFactor: number; // The factor used (Global or Room)
  margin: number; // The margin used
}

export interface ProjectSpecs {
  manufacturer?: string;
  priceGroup?: string; // Excel Column (Tier)

  // --- FIELDS MATCHING SCREENSHOT "Kitchen: Area Name" ---
  // Row 1
  lineType?: string; // Cabinet Line
  cardboardBoxed?: string; // Cardboard Boxed Cabinets (Yes/No)
  // Wall/Base Door derived from below styles combined
  
  // Row 2
  wallDoorStyle?: string; // Wall Door Style
  baseDoorStyle?: string; // Base Door Style
  wallDoorOption?: string; // Wall Door Option (e.g. Standard)
  baseDoorOption?: string; // Base Door Option (e.g. Standard)
  doorEdge?: string; // Door Edge
  
  // Row 3
  drawerBox?: string; // Drawer Box
  drawerFront?: string; // Drawer Front
  hingeType?: string; // Hinge
  
  // Row 4
  softCloseHinges?: string; // Soft Close Hinges (Yes/No)
  woodSpecies?: string; // Wood
  finishColor?: string; // Stain Color
  
  // Row 5
  glaze?: string; // Glaze
  finishOption1?: string; // Finish Option 1
  finishOption2?: string; // Finish Option 2
  
  // Row 6
  printedEndOption?: string; // Printed Ends
  highlights?: string; // Highlights

  seriesName?: string; // Section B (often redundant with Line/Price Group but good for logic)
  
  // CONSTRUCTION & UPGRADES (Checkboxes for extra line items)
  selectedOptions?: Record<string, boolean>; 
  
  // DYNAMIC SELECTIONS (For Dropdowns/Single-Select Categories)
  // Maps Category Name -> Selected Option Name
  dynamicSelections?: Record<string, string>;

  notes?: string;
}

export interface ProjectFinancials {
  taxRate: number; // Percentage (e.g., 7.5 for 7.5%)
  shippingCost: number; // Fixed Dollar Amount (Freight)
  discountRate: number; // Percentage (Legacy - maybe unused now?)
  fuelSurcharge: number; // Fixed Dollar Amount
  miscCharge: number; // Fixed Dollar Amount
  
  // New Pricing Logic
  pricingFactor: number; // Manufacturer Multiplier (e.g. 0.45)
  roomFactors?: Record<string, number>; // Room overrides
  
  globalMargin: number; // Target Margin % (e.g. 35)
  categoryMargins?: Record<string, number>; // Per-Series/Level margins
  
  manufacturerUpcharge?: number; // % Upcharge on List
}

export interface ContactDetails {
    name: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    phone: string;
    email?: string;
}

export interface DealerDetails extends ContactDetails {
    contactPerson?: string;
}

export interface Project {
  id: string;
  name: string;
  clientName: string;
  dateCreated: string;
  status: 'Draft' | 'Quoted' | 'Ordered';
  items: CabinetItem[];
  specs?: ProjectSpecs;
  roomSpecs?: Record<string, ProjectSpecs>; // NEW: Per-Room Specs
  manufacturerId?: string;
  pricing?: PricingLineItem[];
  selectedTierId?: string;
  financials?: ProjectFinancials;
  
  // New Details
  customerDetails?: ContactDetails;
  dealerDetails?: DealerDetails;
  deliveryDetails?: ContactDetails; // Reusing ContactDetails for structure
}

export interface QuotationState {
  step: number;
  isLoading: boolean;
  project: Project;
  error?: string;
}

export interface NKBARules {
  filename: string;
  uploadDate: string;
  size: number;
  isActive: boolean;
  data?: string; 
}