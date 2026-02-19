import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  UploadCloud, CheckCircle2, ChevronRight, FileOutput, 
  Settings2, DollarSign, Printer, ArrowRight, AlertCircle, Edit2, AlertTriangle, Info,
  ArrowLeft, Layers, Package, RefreshCw, AlertOctagon, Check, Tags, PenTool, Database, Server, Link2, DownloadCloud, FileText,
  PaintBucket, Hammer, Shield, Grid3X3, Trash2, Calculator, Truck, User, Building2, MapPin, Plus
} from 'lucide-react';
import { Button } from '../components/Button';
import { STEPS } from '../constants';
import { CabinetItem, Project, PricingLineItem, Manufacturer, CabinetType, ManufacturerOption, ProjectFinancials, ContactDetails, DealerDetails, ProjectSpecs } from '../types';
import { storage } from '../services/storage';
import { calculateProjectPricing, normalizeNKBACode } from '../services/pricingEngine';
import { analyzePlan } from '../services/ai';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

// --- HELPER COMPONENT: SpecField (Optimized for Performance) ---
// Moved outside main component to prevent re-creation on render
// Uses local state + onBlur to prevent heavy storage writes on every keystroke
const SpecField = ({ label, value, onChange, type = 'text', options = [] }: any) => {
    const [localValue, setLocalValue] = useState(value || '');

    // Sync local state if prop changes externally (e.g. loading a new project)
    useEffect(() => {
        setLocalValue(value || '');
    }, [value]);

    const handleBlur = () => {
        // Only trigger the heavy update (storage save) when user leaves the field
        if (localValue !== value) {
            onChange(localValue);
        }
    };

    return (
        <div className="flex flex-col">
            <label className="text-[10px] uppercase font-bold text-slate-500 mb-1">{label}</label>
            {type === 'select' ? (
                <select 
                    className="w-full p-2 border border-slate-300 rounded text-sm bg-white focus:ring-2 focus:ring-brand-500 outline-none" 
                    value={localValue} 
                    onChange={(e) => {
                        const val = e.target.value;
                        setLocalValue(val);
                        onChange(val); // Selects commit immediately
                    }}
                >
                    <option value="">Select...</option>
                    {options.map((opt: any) => (
                        typeof opt === 'object' ? 
                        <option key={opt.id || opt.value} value={opt.value || opt.name}>{opt.label || opt.name}</option> :
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            ) : (
                <input 
                    type="text" 
                    className="w-full p-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500 outline-none" 
                    value={localValue} 
                    onChange={(e) => setLocalValue(e.target.value)}
                    onBlur={handleBlur} // Commit on blur
                />
            )}
        </div>
    );
};

// --- NEW HELPER: DebouncedInput (For Tables/Grids) ---
const DebouncedInput = ({ value, onChange, className, type = "text", ...props }: any) => {
    const [local, setLocal] = useState(value || '');
    useEffect(() => setLocal(value || ''), [value]);
    
    return (
        <input 
            type={type}
            className={className}
            value={local} 
            onChange={e => setLocal(e.target.value)} 
            onBlur={() => {
                if (local !== value) onChange(type === 'number' ? parseFloat(local) : local);
            }}
            {...props}
        />
    );
};

export const QuotationFlow: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(0); 
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [selectedMfgId, setSelectedMfgId] = useState<string>('');
  const [selectedDealer, setSelectedDealer] = useState<string | null>(null); // NEW: Dealer Filter
  const [uploadError, setUploadError] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<string | null>(null);
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>(''); // NEW: Catalog Filter
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set()); // NEW: Multi-selection State
  const [toastMessage, setToastMessage] = useState<string | null>(null); // NEW: Toast Notification

  // Financial State Local (synced with project)
  const [financials, setFinancials] = useState<ProjectFinancials>({
      taxRate: 0,
      shippingCost: 0,
      discountRate: 0,
      fuelSurcharge: 0,
      miscCharge: 0,
      pricingFactor: 1.0,
      globalMargin: 0,
      roomFactors: {},
      categoryMargins: {}
  });

  // Details State
  const [customerDetails, setCustomerDetails] = useState<ContactDetails>({
      name: '', address: '', city: '', state: '', zip: '', phone: '', email: ''
  });
  const [dealerDetails, setDealerDetails] = useState<DealerDetails>({
      name: 'Aulin Homes', address: '295 Geneva Drive', city: 'Oviedo', state: 'FL', zip: '32765', phone: '407-542-7002', contactPerson: '', email: ''
  });
  const [deliveryDetails, setDeliveryDetails] = useState<ContactDetails>({
      name: '', address: '', city: '', state: '', zip: '', phone: ''
  });

  useEffect(() => {
    const loadData = async () => {
        const proj = await storage.getActiveProject();
        if (!proj) {
            navigate('/');
            return;
        }
        setProject(proj);
        if (proj.financials) {
            setFinancials(proj.financials);
        }
        if (proj.customerDetails) setCustomerDetails(proj.customerDetails);
        if (proj.dealerDetails) setDealerDetails(proj.dealerDetails);
        if (proj.deliveryDetails) setDeliveryDetails(proj.deliveryDetails);
        
        const m = await storage.getManufacturers();
        setManufacturers(m);
    }
    loadData();
  }, [navigate]);

  useEffect(() => {
      // Auto-fill Delivery with Customer if empty when Customer changes
      if (!deliveryDetails.name && customerDetails.name) {
          setDeliveryDetails({ ...customerDetails });
      }
  }, [customerDetails.name]); // Only trigger once on name change start

  useEffect(() => {
      if (toastMessage) {
          const timer = setTimeout(() => setToastMessage(null), 3000);
          return () => clearTimeout(timer);
      }
  }, [toastMessage]);

  const updateProject = async (updates: Partial<Project>) => {
    if (!project) return;
    const updated = { ...project, ...updates };
    setProject(updated);
    await storage.saveActiveProject(updated);
  };

  const recalculateAllPricing = async (
      currentFinancials: ProjectFinancials, 
      currentItems: CabinetItem[],
      newSpecs?: ProjectSpecs,
      newRoomSpecs?: Record<string, ProjectSpecs>
  ) => {
      if (!project || !project.manufacturerId) return;
      
      const mfg = manufacturers.find(m => m.id === project.manufacturerId);
      if (!mfg) return;

      // Ensure catalog is loaded
      if (!mfg.catalog || Object.keys(mfg.catalog).length === 0) {
          setIsLoading(true);
          setLoadingMessage("Refreshing Price Book...");
          mfg.catalog = await storage.getManufacturerCatalog(project.manufacturerId);
          setIsLoading(false);
          setLoadingMessage("");
      }

      const tierId = project.selectedTierId || 'default';
      const effectiveSpecs = newSpecs || project.specs;
      const effectiveRoomSpecs = newRoomSpecs || project.roomSpecs;
      
      // We need to re-run the pricing engine for ALL items
      // This ensures Factor and Margin changes propagate
      const newPricing = calculateProjectPricing(currentItems, mfg, tierId, effectiveSpecs, currentFinancials, effectiveRoomSpecs);
      
      updateProject({ pricing: newPricing, financials: currentFinancials, specs: effectiveSpecs, roomSpecs: effectiveRoomSpecs });
  };

  const updateFinancials = async (field: keyof ProjectFinancials, value: number) => {
      const newFin = { ...financials, [field]: value };
      setFinancials(newFin);
      
      // If Pricing Logic fields change, we must re-calculate everything
      if (field === 'pricingFactor' || field === 'globalMargin' || field === 'roomFactors') {
          await recalculateAllPricing(newFin, project?.items || []);
      } else {
          updateProject({ financials: newFin });
      }
  };

  const updateRoomFactor = async (roomName: string, factor: number | null) => {
      const newRoomFactors = { ...financials.roomFactors };
      if (factor === null) {
          delete newRoomFactors[roomName];
      } else {
          newRoomFactors[roomName] = factor;
      }
      
      const newFin = { ...financials, roomFactors: newRoomFactors };
      setFinancials(newFin);
      await recalculateAllPricing(newFin, project?.items || []);
  };
  
  const updateProjectItem = (itemId: string, updates: Partial<CabinetItem>) => {
      if (!project) return;
      if (updates.originalCode) {
          updates.normalizedCode = normalizeNKBACode(updates.originalCode);
      }
      const newItems = project.items.map(item => 
          item.id === itemId ? { ...item, ...updates } : item
      );
      updateProject({ items: newItems });
  };

  const deleteProjectItem = (itemId: string) => {
      if (!project) return;
      // Remove from both items and pricing to ensure sync
      const newItems = project.items.filter(item => item.id !== itemId);
      let newPricing = project.pricing;
      if (project.pricing) {
          newPricing = project.pricing.filter(item => item.id !== itemId);
      }
      updateProject({ items: newItems, pricing: newPricing });
  };

  const addBOMItem = (initialSku?: string, targetRoom?: string) => {
      if (!project) return;
      
      const code = typeof initialSku === 'string' ? initialSku : 'NEW';
      const desc = typeof initialSku === 'string' ? 'Added from Catalog' : 'Manual Entry';

      const newItem: PricingLineItem = {
          id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          originalCode: code,
          normalizedCode: code,
          description: desc,
          quantity: 1,
          width: 0, height: 0, depth: 0,
          type: 'Base',
          room: targetRoom || 'General',
          
          // Pricing fields
          basePrice: 0,
          optionsPrice: 0,
          tierMultiplier: 1,
          finalUnitPrice: 0,
          totalPrice: 0,
          tierName: project.selectedTierId || 'Default',
          source: 'Manual Entry',
          appliedOptions: [],
          unitCost: 0,
          pricingFactor: financials.pricingFactor,
          margin: financials.globalMargin,
          isManual: true
      };

      const newItems = [...project.items, newItem];
      const newPricing = project.pricing ? [...project.pricing, newItem] : [newItem];
      
      updateProject({ items: newItems, pricing: newPricing });
      setToastMessage("New manual entry added");
  };

  const handleBOMUpdate = async (itemId: string, field: 'code' | 'quantity' | 'price', value: string | number) => {
      if (!project || !project.pricing) return;
      
      const newPricing = [...project.pricing];
      const index = newPricing.findIndex(i => i.id === itemId);
      if (index === -1) return;
      
      let item = { ...newPricing[index] };
      let shouldReprice = false;

      if (field === 'code') {
          const newCode = (value as string).toUpperCase();
          if (item.originalCode === newCode) return; 
          item.originalCode = newCode;
          item.normalizedCode = normalizeNKBACode(newCode);
          shouldReprice = true;
      } else if (field === 'quantity') {
          const newQty = value as number;
          if (item.quantity === newQty) return;
          item.quantity = newQty;
          item.totalPrice = item.finalUnitPrice * item.quantity;
      } else if (field === 'price') {
          const newPrice = value as number;
          if (item.finalUnitPrice === newPrice) return;
          item.finalUnitPrice = newPrice;
          item.source = "Manual Override";
          item.totalPrice = item.finalUnitPrice * item.quantity;
      }

      if (shouldReprice) {
           const mfgId = project.manufacturerId;
           if (mfgId) {
               const mfg = manufacturers.find(m => m.id === mfgId);
               if (mfg) {
                   if (!mfg.catalog || Object.keys(mfg.catalog).length === 0) {
                       setIsLoading(true);
                       setLoadingMessage("Accessing Price Book...");
                       mfg.catalog = await storage.getManufacturerCatalog(mfgId);
                       setIsLoading(false);
                       setLoadingMessage("");
                   }
                   
                   const rePricedItems = calculateProjectPricing([item], mfg, project.selectedTierId || 'default', project.specs, financials);
                   if (rePricedItems.length > 0) {
                       const newItem = rePricedItems[0];
                       item.basePrice = newItem.basePrice;
                       item.tierMultiplier = newItem.tierMultiplier;
                       
                       // Sync new fields
                       (item as any).unitCost = (newItem as any).unitCost;
                       (item as any).pricingFactor = (newItem as any).pricingFactor;
                       (item as any).margin = (newItem as any).margin;
                       
                       item.finalUnitPrice = newItem.finalUnitPrice;
                       item.totalPrice = newItem.totalPrice;
                       item.source = newItem.source;
                       item.tierName = newItem.tierName;
                   } else {
                       item.finalUnitPrice = 0;
                       item.totalPrice = 0;
                       item.source = "Not Found in Catalog";
                   }
               }
           }
      }

      newPricing[index] = item;
      const updatedProject = { ...project, pricing: newPricing };
      setProject(updatedProject);
      await storage.saveActiveProject(updatedProject);
  };

  const handleBack = () => {
      if (step > 0) {
          setStep(step - 1);
      } else {
          navigate('/');
      }
  };

  const getGroupedItems = <T extends CabinetItem>(items: T[]) => {
    // Group by Room first
    const roomGroups: Record<string, T[]> = {};
    items.forEach(item => {
        const room = item.room || "General";
        if (!roomGroups[room]) roomGroups[room] = [];
        roomGroups[room].push(item);
    });
    
    // Flatten logic: Return { room, items: [...] } sorted by source page (PDF Order)
    return Object.keys(roomGroups).map(room => {
        const roomItems = roomGroups[room].sort((a, b) => {
             // Force Manual Entries to bottom
             const isManualA = a.isManual || a.description === 'Manual Entry' || a.originalCode === 'NEW ITEM';
             const isManualB = b.isManual || b.description === 'Manual Entry' || b.originalCode === 'NEW ITEM';
             if (isManualA && !isManualB) return 1;
             if (!isManualA && isManualB) return -1;

             // Sort by type priority first, then original code
             const typeOrder = ['Base', 'Wall', 'Tall', 'Appliance', 'Accessory', 'Hardware', 'Modification'];
             const idxA = typeOrder.indexOf(a.type || 'Base');
             const idxB = typeOrder.indexOf(b.type || 'Base');
             if (idxA !== idxB) return idxA - idxB;
             return (a.originalCode || '').localeCompare(b.originalCode || '');
        });

        // Determine the "start page" for this room (min sourcePage)
        const minPage = Math.min(...roomItems.map(i => i.sourcePage || 9999));

        return { 
            room, 
            items: roomItems,
            totalQty: roomItems.reduce((sum, i) => sum + i.quantity, 0),
            minPage: minPage // Add minPage for sorting
        };
    }).sort((a, b) => {
        // PDF Page Order Priority
        // If rooms start on different pages, use that order
        if (a.minPage !== b.minPage) return a.minPage - b.minPage;

        // If on same page, sort alphabetically
        return a.room.localeCompare(b.room);
    });
  };

  const handleAddItem = (room: string, type: CabinetType) => {
      if (!project) return;
      const newItem: CabinetItem = {
          id: `manual_${Date.now()}`,
          originalCode: "NEW ITEM",
          quantity: 1,
          type: type,
          description: "Manual Entry",
          width: 0, height: 0, depth: 0,
          normalizedCode: "NEW ITEM",
          room: room,
          isManual: true,
          notes: "Manual Entry"
      };
      const newItems = [...project.items, newItem];
      updateProject({ items: newItems });
      setToastMessage("New manual entry added");
  };

  const handleRenameRoom = (oldName: string, newName: string) => {
      if (!project) return;
      if (!newName || newName.trim() === "") return;
      
      const newItems = project.items.map(item => {
          if ((item.room || "General") === oldName) {
              return { ...item, room: newName };
          }
          return item;
      });

      // Also update pricing items
      let newPricing = project.pricing;
      if (project.pricing) {
          newPricing = project.pricing.map(item => {
              if ((item.room || "General") === oldName) {
                  return { ...item, room: newName };
              }
              return item;
          });
      }

      updateProject({ items: newItems, pricing: newPricing });
  };

  const handleAddRoom = () => {
      if (!project) return;
      const roomName = window.prompt("Enter new room name (e.g., 'Kitchen 2', 'Basement Bar'):");
      if (!roomName || roomName.trim() === "") return;
      
      const newItem: PricingLineItem = {
          id: `manual_${Date.now()}`,
          originalCode: "NOTE",
          quantity: 1,
          type: 'Accessory',
          description: "New Room Created",
          width: 0, height: 0, depth: 0,
          normalizedCode: "NOTE",
          room: roomName.trim(),
          notes: "Initial Item",
          
          // Pricing fields (Required for PricingLineItem)
          basePrice: 0,
          optionsPrice: 0,
          tierMultiplier: 1,
          finalUnitPrice: 0,
          totalPrice: 0,
          tierName: project.selectedTierId || 'Default',
          source: 'System',
          appliedOptions: [],
          unitCost: 0,
          pricingFactor: financials.pricingFactor,
          margin: financials.globalMargin
      };
      
      const newItems = [...project.items, newItem];
      const newPricing = project.pricing ? [...project.pricing, newItem] : [newItem];
      
      updateProject({ items: newItems, pricing: newPricing });
  };

  const toggleSelection = (id: string) => {
      const newSet = new Set(selectedItems);
      if (newSet.has(id)) {
          newSet.delete(id);
      } else {
          newSet.add(id);
      }
      setSelectedItems(newSet);
  };

  const toggleRoomSelection = (roomName: string, items: CabinetItem[]) => {
      const newSet = new Set(selectedItems);
      const roomItemIds = items.map(i => i.id);
      const allSelected = roomItemIds.every(id => newSet.has(id));

      if (allSelected) {
          roomItemIds.forEach(id => newSet.delete(id));
      } else {
          roomItemIds.forEach(id => newSet.add(id));
      }
      setSelectedItems(newSet);
  };

  const handleBulkDelete = () => {
      if (!project) return;
      if (!window.confirm(`Are you sure you want to delete ${selectedItems.size} selected items?`)) return;
      
      const newItems = project.items.filter(item => !selectedItems.has(item.id));
      // Also clean up pricing items if they exist
      let newPricing = project.pricing;
      if (project.pricing) {
          newPricing = project.pricing.filter(item => !selectedItems.has(item.id));
      }
      
      updateProject({ items: newItems, pricing: newPricing });
      setSelectedItems(new Set());
  };

  const handleBulkMove = () => {
      if (!project) return;
      // Get unique existing rooms to suggest (could be improved with a proper modal, but prompt is fast)
      const roomName = window.prompt("Enter target room name (e.g., 'Kitchen', 'Laundry'):");
      if (!roomName || roomName.trim() === "") return;
      
      const newItems = project.items.map(item => {
          if (selectedItems.has(item.id)) {
              return { ...item, room: roomName.trim() };
          }
          return item;
      });
      
      updateProject({ items: newItems });
      setSelectedItems(new Set());
  };

  const handleDeleteRoom = (roomName: string) => {
      if (!project) return;
      if (!window.confirm(`Are you sure you want to delete the entire room "${roomName}" and all its items?`)) return;
      
      const newItems = project.items.filter(item => (item.room || "General") !== roomName);
      updateProject({ items: newItems });
  };

  const generatePDFDocument = (proj: Project, summaryOnly: boolean = false): jsPDF => {
    if (!proj || !proj.pricing) throw new Error("No project data");
    const doc = new jsPDF();
    const today = new Date().toLocaleDateString();
    const validItems = proj.pricing.filter(item => item.totalPrice > 0);
    const fin = proj.financials || { taxRate: 0, shippingCost: 0, discountRate: 0, fuelSurcharge: 0, miscCharge: 0 };
    const dealer = proj.dealerDetails || dealerDetails;
    const customer = proj.customerDetails || customerDetails;
    const s: ProjectSpecs = proj.specs || {};

    // --- HEADER ---
    doc.setFontSize(28);
    doc.setFont("times", "italic");
    const mfgName = s.manufacturer || "Cabinet Proposal";
    doc.text(mfgName, 45, 20);
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    if (mfgName.toLowerCase().includes('midland')) {
        doc.text("A Division of Koch Cabinets", 47, 25);
    }

    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(summaryOnly ? "Proposal Summary" : "Order", 170, 18, { align: 'right' });
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const headerX = 170;
    let headerY = 24;
    
    if (mfgName.toLowerCase().includes('midland') || mfgName.toLowerCase().includes('koch')) {
        doc.text("111 North 1St. St.", headerX, headerY, { align: 'right' }); headerY += 4;
        doc.text("Seneca KS, 66538", headerX, headerY, { align: 'right' }); headerY += 4;
        doc.text("Phone: 877-540-5624", headerX, headerY, { align: 'right' }); headerY += 4;
        doc.text("Email: orders@kochcabinet.com", headerX, headerY, { align: 'right' });
    }

    // --- DEALER INFO ---
    let yPos = 45;
    const boxWidth = 182;
    const leftMargin = 14;

    // Header Box
    doc.setDrawColor(100);
    doc.setLineWidth(0.1);
    doc.setFillColor(230, 230, 230); // Light Gray
    doc.rect(leftMargin, yPos, boxWidth, 6, 'FD'); 
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0);
    doc.text("Dealer Information", leftMargin + 2, yPos + 4.5);
    
    // Content Box
    const dealerBoxH = 26;
    doc.setFillColor(255, 255, 255);
    doc.rect(leftMargin, yPos + 6, boxWidth, dealerBoxH); 
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "italic");
    let infoY = yPos + 11;
    doc.text(dealer.name || "Dealer Name", leftMargin + 4, infoY); infoY += 4;
    doc.text(dealer.address || "", leftMargin + 4, infoY); infoY += 4;
    doc.text(`${dealer.city || ''} ${dealer.state || ''}, ${dealer.zip || ''}`, leftMargin + 4, infoY); infoY += 4;
    doc.text(`Phone: ${dealer.phone || ''}`, leftMargin + 4, infoY);

    yPos += 6 + dealerBoxH + 4; // Gap

    // --- PROJECT INFO ---
    doc.setFillColor(230, 230, 230);
    doc.rect(leftMargin, yPos, boxWidth, 6, 'FD');
    doc.setFont("helvetica", "bold");
    doc.text("Project Information", leftMargin + 2, yPos + 4.5);

    const projBoxH = 15;
    doc.setFillColor(255, 255, 255);
    doc.rect(leftMargin, yPos + 6, boxWidth, projBoxH);

    doc.setFontSize(8);
    const row1Y = yPos + 10;
    const row2Y = yPos + 15;
    
    // Col 1
    doc.setFont("helvetica", "normal"); doc.text("Project Name:", leftMargin + 4, row1Y);
    doc.setFont("helvetica", "normal"); doc.text(proj.name || "Kitchen", leftMargin + 30, row1Y);
    doc.setFont("helvetica", "normal"); doc.text("Project Type:", leftMargin + 4, row2Y);
    doc.setFont("helvetica", "normal"); doc.text("New Construction", leftMargin + 30, row2Y);

    // Col 2
    doc.setFont("helvetica", "normal"); doc.text("Customer:", leftMargin + 70, row1Y);
    doc.setFont("helvetica", "normal"); doc.text(customer.name || "", leftMargin + 90, row1Y);
    doc.setFont("helvetica", "normal"); doc.text("Phone:", leftMargin + 70, row2Y);
    doc.setFont("helvetica", "normal"); doc.text(customer.phone || "", leftMargin + 90, row2Y);

    // Col 3
    doc.setFont("helvetica", "normal"); doc.text("Project #:", leftMargin + 130, row1Y);
    doc.setFont("helvetica", "normal"); doc.text(proj.id.substring(0,8), leftMargin + 145, row1Y);
    doc.setFont("helvetica", "normal"); doc.text("Date:", leftMargin + 130, row2Y);
    doc.setFont("helvetica", "normal"); doc.text(today, leftMargin + 145, row2Y);

    yPos += 6 + projBoxH + 4;

    // --- KITCHEN SPECS ---
    doc.setFillColor(230, 230, 230);
    doc.rect(leftMargin, yPos, boxWidth, 6, 'FD');
    doc.setFont("helvetica", "bold");
    doc.text(`Kitchen: ${proj.name || 'Quote'}`, leftMargin + 2, yPos + 4.5);

    const specsBoxH = 34;
    doc.setFillColor(255, 255, 255);
    doc.rect(leftMargin, yPos + 6, boxWidth, specsBoxH);

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");

    let sY = yPos + 11;
    const sInc = 5;
    const c1 = leftMargin + 4; const v1 = c1 + 25;
    const c2 = leftMargin + 65; const v2 = c2 + 30;
    const c3 = leftMargin + 125; const v3 = c3 + 25;

    // Row 1
    doc.text("Cabinet Line:", c1, sY); doc.text(s.lineType || s.manufacturer || "Standard", v1, sY);
    doc.text("Cardboard Boxed:", c2, sY); doc.text(s.cardboardBoxed || "No", v2, sY);
    doc.text("Wall/Base Door:", c3, sY); doc.text(`${s.wallDoorStyle || 'Pioneer'}`, v3, sY);
    sY += sInc;

    // Row 2
    doc.text("Wall Door Option:", c1, sY); doc.text(s.wallDoorOption || "Standard", v1, sY);
    doc.text("Base Door Option:", c2, sY); doc.text(s.baseDoorOption || "Standard", v2, sY);
    doc.text("Door Edge:", c3, sY); doc.text(s.doorEdge || "N/A", v3, sY);
    sY += sInc;

    // Row 3
    doc.text("Drawer Box:", c1, sY); doc.text(s.drawerBox || "Standard", v1, sY);
    doc.text("Drawer Front:", c2, sY); doc.text(s.drawerFront || "5-Piece", v2, sY);
    doc.text("Hinge:", c3, sY); doc.text(s.hingeType || "Full", v3, sY);
    sY += sInc;

    // Row 4
    doc.text("Soft Close:", c1, sY); doc.text(s.softCloseHinges || "Yes", v1, sY);
    doc.text("Wood:", c2, sY); doc.text(s.woodSpecies || "Paint Grade", v2, sY);
    doc.text("Stain Color:", c3, sY); doc.text(s.finishColor || "Oyster", v3, sY);
    sY += sInc;

    // Row 5
    doc.text("Glaze:", c1, sY); doc.text(s.glaze || "None", v1, sY);
    doc.text("Finish Option 1:", c2, sY); doc.text(s.finishOption1 || "None", v2, sY);
    doc.text("Finish Option 2:", c3, sY); doc.text(s.finishOption2 || "None", v3, sY);
    sY += sInc;

    // Row 6
    if (s.printedEndOption && s.printedEndOption !== 'No') {
         doc.text("Printed Ends:", c1, sY); doc.text(s.printedEndOption, v1, sY);
    }
    if (s.highlights) {
         doc.text("Highlights:", c2, sY); doc.text(s.highlights, v2, sY);
    }

    yPos += 6 + specsBoxH + 4;

    // --- GROUPED ITEMS LOGIC ---
    // 1. Group All Items by Room for PDF
    const roomGroups: Record<string, PricingLineItem[]> = {};
    validItems.forEach(item => {
        const room = item.room || "General / Additional Items";
        if (!roomGroups[room]) roomGroups[room] = [];
        roomGroups[room].push(item);
    });

    if (summaryOnly) {
         // --- SUMMARY TABLE ---
         const summaryBody: any[] = [];
         
         // Items by Room
         Object.entries(roomGroups).forEach(([roomName, items]) => {
             const roomTotal = items.reduce((sum, i) => sum + i.totalPrice, 0);
             const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
             summaryBody.push([roomName, `${itemCount} items`, `$${roomTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`]);
         });
         
         autoTable(doc, {
            startY: yPos,
            head: [['Area / Category', 'Quantity', 'Total Price']],
            body: summaryBody,
            theme: 'plain',
            styles: { fontSize: 9, cellPadding: 3, lineColor: [200, 200, 200], lineWidth: 0.1, valign: 'middle' },
            headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold', lineWidth: 0.1, lineColor: [200, 200, 200] },
            columnStyles: {
                0: { cellWidth: 130, fontStyle: 'bold' },
                1: { cellWidth: 30, halign: 'center' },
                2: { cellWidth: 30, halign: 'right' }
            },
            margin: { left: 14, right: 14 },
         });
         
         yPos = (doc as any).lastAutoTable.finalY + 10;

    } else {
        // --- DETAILED TABLES ---
        
        // Helper to print a table for a group of items
        const printTable = (title: string, items: PricingLineItem[], headerColor: [number, number, number] = [240, 240, 240]) => {
            if (items.length === 0) return;

            // Check for page break
            if (yPos > doc.internal.pageSize.getHeight() - 40) {
                doc.addPage();
                yPos = 20;
            }

            // Header
            doc.setFillColor(...headerColor);
            doc.rect(leftMargin, yPos, boxWidth, 7, 'F');
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(0);
            doc.text(title, leftMargin + 2, yPos + 5);
            yPos += 7;

            // Body
            const tableBody: any[] = [];
            
            // Sub-Grouping Logic
            const categorized: Record<string, PricingLineItem[]> = {};
            items.forEach(item => {
                 let cat = item.type as string;
                 const roomLower = title.toLowerCase();
                 
                 // Map Types to Display Categories (Consistent with UI)
                 if (item.isManual || item.originalCode === 'NEW ITEM' || item.description === 'Manual Entry') {
                     cat = 'Manual / Added Items';
                 }
                 else if (cat === 'Vanity') {
                     cat = 'Vanity Cabinets';
                 }
                 else if (cat === 'Base') {
                     cat = (roomLower.includes('bath') || roomLower.includes('vanity') || roomLower.includes('ensuite') || roomLower.includes('powder')) 
                         ? 'Vanity Cabinets' 
                         : 'Base Cabinets';
                 }
                 else if (cat === 'Wall') cat = 'Wall Cabinets';
                 else if (cat === 'Tall') cat = 'Tall Cabinets';
                 else if (cat === 'Hardware') cat = 'Hinges & Hardware';
                 else if (cat === 'Filler') cat = 'Fillers';
                 else if (cat === 'Finishing' || cat === 'Panel') cat = 'Finishing & Panels';
                 else if (cat === 'Appliance') cat = 'Appliances';
                 else if (cat === 'Accessory') cat = 'Accessories';
                 else if (cat === 'Modification') cat = 'Modifications';
                 else cat = 'Other Items';

                 if (!categorized[cat]) categorized[cat] = [];
                 categorized[cat].push(item);
            });

            const displayOrder = [
                'Wall Cabinets', 'Base Cabinets', 'Vanity Cabinets', 'Tall Cabinets', 
                'Appliances', 'Hinges & Hardware', 'Fillers', 'Finishing & Panels', 
                'Accessories', 'Modifications', 'Other Items', 'Manual / Added Items'
            ];

            const sortedCats = Object.keys(categorized).sort((a, b) => {
                const ia = displayOrder.indexOf(a);
                const ib = displayOrder.indexOf(b);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });

            let globalIndex = 1;

            sortedCats.forEach(cat => {
                // Add Category Header Row
                tableBody.push([{ 
                    content: cat, 
                    colSpan: 5, 
                    styles: { fillColor: [250, 250, 250], fontStyle: 'bold', textColor: [80, 80, 80], halign: 'left', cellPadding: 1 } 
                }]);

                categorized[cat].forEach((item) => {
                    const codeWithDims = item.width > 0 
                        ? `${item.originalCode}\n${item.width}"W x ${item.height}"H x ${item.depth}"D`
                        : item.originalCode;

                    tableBody.push([
                        globalIndex.toString(),
                        item.quantity.toString(),
                        codeWithDims,
                        `$${item.totalPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`
                    ]);
                    globalIndex++;
                    
                    // Modifications & Options logic...
                    if (item.modifications) {
                        item.modifications.forEach((mod) => {
                            tableBody.push(['', '', `${mod.description.includes('FINISH END') ? (mod.description.includes('Left') ? 'FEL' : 'FER') : 'MOD'} - ${mod.description}`, `$${(mod.price || 0).toFixed(2)}`]);
                        });
                    }
                    if (item.appliedOptions) {
                        item.appliedOptions.forEach((opt) => {
                            tableBody.push(['', '', `OPT - ${opt.name}`, `$${opt.price.toFixed(2)}`]);
                        });
                    }
                });
            });

            autoTable(doc, {
                startY: yPos,
                head: [['Item', 'Qty.', 'Product Code', 'Price']],
                body: tableBody,
                theme: 'plain',
                styles: { fontSize: 8, cellPadding: 2, lineColor: [200, 200, 200], lineWidth: 0.1, valign: 'middle' },
                headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', lineWidth: 0.1, lineColor: [200, 200, 200] },
                columnStyles: {
                    0: { cellWidth: 10, halign: 'center' },
                    1: { cellWidth: 10, halign: 'center' },
                    2: { cellWidth: 130, fontStyle: 'bold' },
                    3: { cellWidth: 30, halign: 'right' }
                },
                margin: { left: 14, right: 14, top: 20, bottom: 20 },
                didParseCell: (data) => {
                     if (data.section === 'body' && data.column.index === 3) {
                         const text = data.cell.raw as string;
                         if (text.includes('CHECK PRICE')) {
                             data.cell.styles.textColor = [220, 38, 38];
                             data.cell.styles.fontStyle = 'bold';
                         }
                    }
                }
            });

            yPos = (doc as any).lastAutoTable.finalY + 2;

            // Subtotal
            const total = items.reduce((sum, i) => sum + i.totalPrice, 0);
            if (yPos > doc.internal.pageSize.getHeight() - 15) {
                doc.addPage();
                yPos = 20;
            }
            doc.setFontSize(9);
            doc.setFont("helvetica", "bold");
            doc.text(`${title} Total: $${total.toLocaleString(undefined, {minimumFractionDigits: 2})}`, 196 - 14, yPos + 5, { align: 'right' });
            yPos += 12;
        };

        // 1. Room Tables (Includes all categories)
        Object.entries(roomGroups).forEach(([roomName, items]) => {
            printTable(roomName, items);
        });
        
        // 4. Appliances (Optional - usually not priced, but if we wanted to show them...)
        // We typically exclude them from the formal quote unless they have prices.
    }

    // --- TOTALS ---
    const subTotal = validItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discountAmount = subTotal * (fin.discountRate / 100);
    const postDiscount = subTotal - discountAmount;
    const taxAmount = postDiscount * (fin.taxRate / 100);
    const grandTotal = postDiscount + taxAmount + fin.shippingCost + fin.fuelSurcharge + fin.miscCharge;

    // Fix for Multi-page download:
    // Check if there is enough space for the summary on the current page.
    let finalY = yPos;
    const pageHeight = doc.internal.pageSize.getHeight();
    const requiredSpaceForSummary = 80; // height of summary box + margins

    if (finalY + requiredSpaceForSummary > pageHeight - 14) {
        doc.addPage();
        finalY = 20; // Start at top margin of new page
    }
    
    // Subtotal Bar
    doc.setFillColor(230, 230, 230);
    doc.rect(leftMargin, finalY, boxWidth, 8, 'F');
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Project Sub Total", 110, finalY + 5.5);
    doc.text(`$${subTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`, 196 - 14, finalY + 5.5, { align: 'right' });

    // Summary Box
    const summaryY = finalY + 12;
    // Left Header for Summary
    doc.setFillColor(230, 230, 230);
    doc.rect(leftMargin, summaryY, 80, 6, 'FD');
    doc.text("Summarized Order Totals", leftMargin + 2, summaryY + 4.5);
    
    const sumTableX = 100;
    const sumTableY = summaryY;
    const rowH = 5;
    
    // Summary Border
    doc.setDrawColor(200);
    doc.rect(sumTableX, sumTableY, 96, 60);

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    
    let cY = sumTableY + 4;
    
    const addSumRow = (label: string, val: string, bold = false) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        if (bold) doc.setFontSize(10);
        doc.text(label, sumTableX + 2, cY);
        doc.text(val, sumTableX + 94, cY, { align: 'right' });
        doc.setDrawColor(220);
        doc.line(sumTableX, cY + 1.5, sumTableX + 96, cY + 1.5);
        cY += rowH;
        if (bold) doc.setFontSize(8);
    };

    addSumRow("Cabinets Total", `$${subTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`);
    
    if (fin.discountRate > 0) {
        addSumRow(`Dealer Discount (${fin.discountRate}%)`, `($${discountAmount.toLocaleString(undefined, {minimumFractionDigits: 2})})`);
    } else {
        addSumRow("Dealer Discount", "($0.00)");
    }
    
    addSumRow("Drawer Track Upgrade Total", "$0.00");
    addSumRow("Soft Close Hinge Upgrade Total", "$0.00"); 
    addSumRow("Construction/Mod Total", "$0.00");
    addSumRow("Products Net Total", `$${postDiscount.toLocaleString(undefined, {minimumFractionDigits: 2})}`);

    if (fin.shippingCost > 0) addSumRow("Shipping Charges", `$${fin.shippingCost.toLocaleString(undefined, {minimumFractionDigits: 2})}`);
    else addSumRow("Shipping Charges", "$0.00");

    if (fin.fuelSurcharge > 0) addSumRow("Fuel Surcharge", `$${fin.fuelSurcharge.toLocaleString(undefined, {minimumFractionDigits: 2})}`);
    else addSumRow("Fuel Surcharge", "$0.00");

    if (fin.taxRate > 0) addSumRow(`Sales Tax (${fin.taxRate}%)`, `$${taxAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}`);
    
    // Grand Total Background
    doc.setFillColor(230, 230, 230);
    doc.rect(sumTableX, cY - 3.5, 96, 7, 'F');
    addSumRow("Order Grand Total *", `$${grandTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`, true);

    doc.setFontSize(7);
    doc.setFont("helvetica", "italic");
    doc.text("* Net Price with Factor Applied", sumTableX + 2, cY + 4);

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.text(`Copyright © ${today.split('/')[2]}`, 14, 285);
    doc.text(`Printed : ${new Date().toLocaleString()}`, 140, 285);

    return doc;
  };

  const handleDownloadPDF = (summary: boolean = false) => {
      if (!project) return;
      try {
          const suffix = summary ? "_Summary" : "";
          const defaultName = `Order_${project.id.substring(0,6)}${suffix}`;
          const fileName = window.prompt("Enter filename for PDF:", defaultName);
          if (!fileName) return; // User cancelled

          const doc = generatePDFDocument(project, summary);
          // Ensure .pdf extension
          const finalName = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
          doc.save(finalName);
      } catch (err) {
          console.error("PDF Generation Failed", err);
          alert("Failed to generate PDF. Please try again or reduce item count.");
      }
  };

  const handleOrderDetailsSubmit = () => {
      updateProject({ customerDetails, dealerDetails, deliveryDetails });
      setStep(6);
  };

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
          const file = files[0];
          // Check type
          if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
              setUploadError("Only PDF or Image files are allowed.");
              return;
          }
          await processUploadedFile(file);
      }
  };

  const processUploadedFile = async (file: File) => {
    // Check file size immediately to prevent browser freeze/timeout
    if (file.size > 20 * 1024 * 1024) {
         setUploadError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 20MB. Please compress or split the PDF.`);
         return;
    }

    setIsLoading(true);
    setLoadingMessage("Reading file...");
    setUploadError('');
    try {
        const nkbaRules = await storage.getNKBARules();
        
        // Wait a tick to ensure UI updates
        await new Promise(r => setTimeout(r, 100));

        setLoadingMessage("AI Vision Analyzing Plan...");
        const result = await analyzePlan(file, nkbaRules?.data, setLoadingMessage);
        
        if (result.items.length === 0) {
            setUploadError("No cabinets detected. Please ensure the PDF contains a clear schedule or plan.");
            setIsLoading(false);
            setLoadingMessage("");
            return;
        }
        await updateProject({ items: result.items, specs: result.specs });
        setIsLoading(false);
        setLoadingMessage("");
        setStep(1); 
    } catch (err: any) {
        console.error(err);
        setUploadError(err.message || "Failed to process file.");
        setIsLoading(false);
        setLoadingMessage("");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processUploadedFile(file);
  };

  const handleConfirmExtraction = () => setStep(2);

  const handleConnectMfg = async (mfg: Manufacturer) => {
    setSelectedMfgId(mfg.id);
    setIsConnecting(mfg.id);
    setLoadingMessage(`Establishing connection to ${mfg.name} database...`);
    const catalogData = await storage.getManufacturerCatalog(mfg.id);
    mfg.catalog = catalogData;
    const skuCount = catalogData ? Object.keys(catalogData).length : 0;
    setLoadingMessage(`Loaded ${skuCount.toLocaleString()} SKUs across ${mfg.tiers.length} pricing tiers...`);
    await new Promise(r => setTimeout(r, 800));
    const defaultSeries = mfg.series && mfg.series.length > 0 ? mfg.series[0].name : '';
    const defaultSpecs: any = {
        ...project?.specs,
        manufacturer: mfg.name,
        priceGroup: mfg.tiers[0]?.name || 'Standard',
        seriesName: defaultSeries,
        lineType: mfg.name, // Default preference
        cardboardBoxed: 'No',
        softCloseHinges: 'Yes',
        glaze: 'None',
        highlights: 'None',
        finishOption1: 'None',
        finishOption2: 'None',
        selectedOptions: {}
    };
    await updateProject({ manufacturerId: mfg.id, specs: defaultSpecs });
    setIsConnecting(null);
    setLoadingMessage("");
    setStep(3); 
  };

  const handleSpecsConfirmed = async () => {
     if (!project || !project.manufacturerId) return;
     const mfg = manufacturers.find(m => m.id === project.manufacturerId);
     if (mfg) {
         setIsLoading(true);
         setLoadingMessage("Running Pricing Engine against Catalog...");
         if (!mfg.catalog || Object.keys(mfg.catalog).length === 0) {
             mfg.catalog = await storage.getManufacturerCatalog(mfg.id);
         }
         let tierIdToUse = project.selectedTierId;
         const targetPriceGroup = project.specs?.seriesName || project.specs?.priceGroup || 'Standard';
         let matchingTier = mfg.tiers.find(t => t.name === targetPriceGroup);
         if (!matchingTier) matchingTier = mfg.tiers.find(t => t.name.toLowerCase().includes(targetPriceGroup.toLowerCase()));
         if (!matchingTier) matchingTier = mfg.tiers.find(t => targetPriceGroup.toLowerCase().includes(t.name.toLowerCase()));

         if (!matchingTier && project.specs?.wallDoorStyle) {
             const style = project.specs.wallDoorStyle.toLowerCase();
             matchingTier = mfg.tiers.find(t => {
                 const n = t.name.toLowerCase();
                 return n.includes(style) && n.includes(targetPriceGroup.toLowerCase());
             });
         }
         if (matchingTier) {
             tierIdToUse = matchingTier.id;
         } else if (mfg.tiers.length > 0) {
             tierIdToUse = mfg.tiers[0].id; 
         } else {
             tierIdToUse = 'default';
             mfg.tiers = [{ id: 'default', name: 'Standard', multiplier: 1.0 }];
         }
         if (tierIdToUse) {
             const pricing = calculateProjectPricing(project.items, mfg, tierIdToUse, project.specs, financials, project.roomSpecs);
             await updateProject({ pricing, selectedTierId: tierIdToUse });
             setIsLoading(false);
             setLoadingMessage("");
             setStep(4); 
         }
     }
  };

  const updateSpec = (field: keyof ProjectSpecs, value: string) => {
     if (!project) return;
     const newSpecs = { ...project.specs, [field]: value };
     recalculateAllPricing(financials, project.items, newSpecs);
  };

  const updateDynamicSelection = (category: string, value: string) => {
      if (!project) return;
      const currentDyn = project.specs?.dynamicSelections || {};
      
      // Check for dependent resets
      const updates: Partial<ProjectSpecs> = {};
      const newDyn = { ...currentDyn, [category]: value };

      if (category === 'Collection') {
          updates.seriesName = value; 
          updates.priceGroup = value; // Sync Price Group (Tier) with Collection
          // Reset dependent Door Style when Collection changes
          newDyn['DoorStyle'] = ''; 
          updates.wallDoorStyle = '';
      }
      if (category === 'Series') {
          updates.seriesName = value;
          updates.priceGroup = value;
      }
      if (category === 'DoorStyle') updates.wallDoorStyle = value;
      if (category === 'Finish' || category === 'Paint' || category === 'Stain') updates.finishColor = value;
      if (category === 'Hinge') updates.hingeType = value;
      if (category === 'Drawer') updates.drawerBox = value;

      updates.dynamicSelections = newDyn;
      const newSpecs = { ...project.specs, ...updates };
      recalculateAllPricing(financials, project.items, newSpecs);
  };

  const updateRoomDynamicSelection = (roomName: string, category: string, value: string) => {
      if (!project) return;
      const currentRoomSpecs = project.roomSpecs || {};
      const roomSpec = currentRoomSpecs[roomName] || {};
      const currentDyn = roomSpec.dynamicSelections || {};

      // Logic mirrors updateDynamicSelection but for a specific room
      const updates: Partial<ProjectSpecs> = {};
      const newDyn = { ...currentDyn, [category]: value };

      if (category === 'Collection') {
          updates.seriesName = value; 
          updates.priceGroup = value; // IMPORTANT: Room Price Group Override
          newDyn['DoorStyle'] = ''; 
          updates.wallDoorStyle = '';
      }
      if (category === 'Series') {
          updates.seriesName = value;
          updates.priceGroup = value;
      }
      if (category === 'DoorStyle') updates.wallDoorStyle = value;
      if (category === 'Finish' || category === 'Paint' || category === 'Stain') updates.finishColor = value;

      updates.dynamicSelections = newDyn;
      
      const newRoomSpec = { ...roomSpec, ...updates };
      const newRoomSpecs = { ...currentRoomSpecs, [roomName]: newRoomSpec };
      
      recalculateAllPricing(financials, project.items, undefined, newRoomSpecs);
  };

  const toggleOption = (optionId: string, checked: boolean) => {
      if (!project || !project.specs) return;
      const newSelected = { ...project.specs.selectedOptions, [optionId]: checked };
      const newSpecs = { ...project.specs, selectedOptions: newSelected };
      recalculateAllPricing(financials, project.items, newSpecs);
  };


  if (!project) return null;
  const currentMfg = manufacturers.find(m => m.id === project.manufacturerId);
  const groupedReviewItems = getGroupedItems(project.items);

  // Group options for display
  const groupedOptions: Record<string, ManufacturerOption[]> = {};
  
  // Helper to ensure group exists
  const ensureGroup = (key: string) => {
      if (!groupedOptions[key]) groupedOptions[key] = [];
  };

  if (currentMfg && currentMfg.options) {
      currentMfg.options.forEach(opt => {
          let cat: string = opt.category || 'Other';
          // Normalize only critical UI groupings, otherwise keep raw
          if (cat === 'Hinge') cat = 'Hardware'; 
          
          ensureGroup(cat);
          groupedOptions[cat].push(opt);
      });
  }
  if (currentMfg?.series?.length > 0) {
      ensureGroup('Series');
      currentMfg.series.forEach(s => {
          if (!groupedOptions['Series'].find(d => d.name === s.name)) {
              groupedOptions['Series'].push({
                  id: `series_${s.id}`, name: s.name, category: 'Series', section: 'B-Series', pricingType: 'included', price: 0
              });
          }
      });
  }
  if (currentMfg?.tiers?.length > 0) {
      currentMfg.tiers.forEach(t => {
          // Extract Collection if present
          if (t.collection) {
               ensureGroup('Collection');
               if (!groupedOptions['Collection'].find(c => c.name === t.collection)) {
                    groupedOptions['Collection'].push({
                        id: `coll_${t.collection}`, 
                        name: t.collection, 
                        category: 'Collection', // Changed from 'Series' to 'Collection' for clarity
                        section: 'B-Series', 
                        pricingType: 'included', 
                        price: 0
                    });
               }
           }
 
           let styleName = '';
           if (t.collection) {
                // If collection is known, try to strip it from the tier name
                if (t.name.startsWith(t.collection)) {
                    styleName = t.name.substring(t.collection.length).replace(/^[\s-:]+/, '');
                } else {
                    styleName = t.name;
                }
           } else if (t.name.includes(' - ')) {
                // Fallback for "Collection - Style" format
                styleName = t.name.split(' - ').slice(1).join(' - ');
           } else {
                styleName = t.name;
           }

           if (styleName && !['Standard', 'Premium', 'Level', 'Group', 'Tier'].some(w => styleName.includes(w))) {
                ensureGroup('DoorStyle');
                // We add ALL variations so we can filter by parentCollection later
                // Check uniqueness by name AND parentCollection
                const existing = groupedOptions['DoorStyle'].find(d => d.name === styleName && (d as any).parentCollection === t.collection);

                if (!existing) {
                     groupedOptions['DoorStyle'].push({
                         id: `tier_derived_${t.collection || 'std'}_${styleName.replace(/\s+/g, '_')}`, 
                         name: styleName, 
                         category: 'DoorStyle', 
                         section: 'Unknown', 
                         pricingType: 'included', 
                         price: 0,
                         parentCollection: t.collection // Store for filtering
                     } as any);
                }
           }

          // Extract Wood Species from Tier Names
          const commonWoods = ['Maple', 'Oak', 'Cherry', 'Alder', 'Walnut', 'Hickory', 'Birch', 'Poplar', 'MDF'];
          commonWoods.forEach(wood => {
              if (t.name.includes(wood)) {
                  ensureGroup('Wood');
                  if (!groupedOptions['Wood'].find(w => w.name === wood)) {
                      groupedOptions['Wood'].push({
                          id: `tier_wood_${wood}`, name: wood, category: 'Other', section: 'Unknown', pricingType: 'included', price: 0
                      });
                  }
              }
          });
      });
  }

  // Sort Categories Logic
  const categoryOrder = [
      'Collection', 'Series', 'DoorStyle', 'Door', 'Wood', 'Finish', 'Paint', 'Stain', 'Glaze', 
      'Construction', 'Drawer', 'Hardware', 'Hinge', 'Door Option', 'Door Edge', 'Highlight', 'PrintedEnd',
      'Toe Kick', 'Depth', 'Size'
  ];
  
  const sortedCategories = Object.keys(groupedOptions).sort((a, b) => {
      const idxA = categoryOrder.indexOf(a);
      const idxB = categoryOrder.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
  });

  return (
    <div className="pb-20">
      <div className="mb-8">
        <div className="flex justify-between text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">
            {STEPS.map((s, i) => (
                <span key={s} className={i <= step ? 'text-brand-600 font-bold' : ''}>
                    {i + 1}. {s}
                </span>
            ))}
        </div>
        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-brand-600 transition-all duration-500 ease-in-out" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 min-h-[500px] p-8 relative">
        {(isLoading || loadingMessage) && (
            <div className="absolute inset-0 bg-white/90 z-50 flex flex-col items-center justify-center animate-in fade-in duration-300">
                 <RefreshCw className="w-12 h-12 text-brand-600 animate-spin mb-4" />
                 <h3 className="text-xl font-bold text-slate-900">{loadingMessage || "Processing..."}</h3>
                 <p className="text-slate-500">Please wait while we connect.</p>
            </div>
        )}

        {/* --- STEPS 0-3 (Upload, Extraction, Manufacturer, Specs) OMITTED FOR BREVITY but they are handled by logic above --- */}
        {step === 0 && (
          <div className="flex flex-col h-full">
             <div className="flex justify-start mb-2"><Button variant="ghost" size="sm" onClick={handleBack} className="text-slate-500 hover:text-slate-900 gap-2 pl-0"><ArrowLeft className="w-4 h-4"/> Back</Button></div>
             <div className="flex flex-col items-center justify-center py-8 text-center space-y-6 flex-1">
                 <div className="w-20 h-20 bg-brand-50 rounded-full flex items-center justify-center mb-4"><UploadCloud className="w-10 h-10 text-brand-600" /></div>
                 <h2 className="text-2xl font-bold text-slate-900">Upload Order or Plan</h2>
                 <p className="text-slate-500 mt-2 mb-6 max-w-sm">Drag & Drop your Order Acknowledgment (PDF) or Kitchen Plan. Our AI will extract codes and pricing.</p>
                 <input type="file" id="plan-upload" className="hidden" accept="image/*,.pdf" onChange={handleFileUpload}/>
                 <div 
                    className={`border-2 border-dashed rounded-xl p-12 w-full max-w-lg transition-all cursor-pointer relative flex flex-col items-center justify-center ${isDragging ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-brand-500 hover:bg-brand-50'}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => document.getElementById('plan-upload')?.click()}
                 >
                    <UploadCloud className={`w-12 h-12 mb-4 ${isDragging ? 'text-brand-600' : 'text-slate-400'}`} />
                    <p className="font-medium text-slate-700">{isDragging ? "Drop file here" : "Click to Browse or Drag File"}</p>
                 </div>
                 {uploadError && <div className="text-red-600 bg-red-50 p-3 rounded-lg"><AlertCircle className="w-4 h-4 inline mr-2"/>{uploadError}</div>}
             </div>
          </div>
        )}
        {step === 1 && (
             <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-3"><Button variant="ghost" size="sm" onClick={handleBack} className="mt-1 shrink-0"><ArrowLeft className="w-5 h-5" /></Button><div><h2 className="text-2xl font-bold text-slate-900">Extraction Review</h2><p className="text-slate-500 text-sm">Review extracted codes. <span className="text-brand-600 font-bold">You can edit codes here if AI misread them.</span></p></div></div>
                    <Button onClick={handleConfirmExtraction} className="w-full sm:w-auto">Next: Manufacturer <ArrowRight className="w-4 h-4 ml-2" /></Button>
                </div>
                <div className="overflow-hidden border border-slate-200 rounded-lg">
                    <table className="min-w-full divide-y divide-slate-200">
                         <thead className="bg-slate-100"><tr><th className="w-10 px-3 py-3 text-center"><input type="checkbox" disabled className="rounded border-slate-300"/></th><th className="px-6 py-3 text-left text-xs font-bold text-slate-500 uppercase">Item Description</th><th className="px-6 py-3 text-left text-xs font-bold text-slate-500 uppercase">PDF Code (Editable)</th><th className="px-6 py-3 text-left text-xs font-bold text-brand-600 uppercase">Normalized</th><th className="px-6 py-3 text-center text-xs font-bold text-slate-500 uppercase">Qty (Editable)</th><th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                           {groupedReviewItems.map(roomGroup => {
                               const roomType = (() => {
                                   const lower = roomGroup.room.toLowerCase();
                                   if (lower.includes('kitchen')) return 'Kitchen';
                                   if (lower.includes('bath') || lower.includes('vanity')) return 'Bathroom';
                                   if (lower.includes('office')) return 'Office';
                                   return 'Room';
                               })();

                               return (
                                   <React.Fragment key={roomGroup.room}>
                                       <tr className="bg-slate-100 border-t-2 border-slate-200">
                                           <td colSpan={6} className="px-3 py-3 font-bold text-sm text-slate-800 uppercase tracking-wider">
                                               <div className="flex items-center justify-between">
                                                   <div className="flex items-center gap-2">
                                                       <input 
                                                           type="checkbox" 
                                                           className="rounded border-slate-300 text-brand-600 focus:ring-brand-500 h-4 w-4"
                                                           checked={roomGroup.items.length > 0 && roomGroup.items.every(i => selectedItems.has(i.id))}
                                                           onChange={() => toggleRoomSelection(roomGroup.room, roomGroup.items)}
                                                       />
                                                                                       <DebouncedInput 
                                                           value={roomGroup.room} 
                                                           onChange={(val: string) => handleRenameRoom(roomGroup.room, val)} 
                                                           className="font-bold bg-transparent border-b border-dashed border-slate-400 focus:border-brand-500 outline-none text-slate-800 min-w-[200px]"
                                                       />
                                                       <span className="text-xs text-slate-500 ml-2">({roomGroup.totalQty} items)</span>
                                                   </div>
                                                   <button 
                                                       onClick={() => handleDeleteRoom(roomGroup.room)}
                                                       className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1 rounded transition-colors"
                                                       title="Delete Entire Room"
                                                   >
                                                       <Trash2 className="w-4 h-4" />
                                                   </button>
                                               </div>
                                           </td>
                                       </tr>
                                       {(() => {
                   // Sub-Distribution Logic
                   const categorized = roomGroup.items.reduce((acc, item) => {
                        let cat = item.type as string;
                        const roomLower = roomGroup.room.toLowerCase();
                        
                        // Check for Manual Items - Group them separately at the end
                        if (item.isManual || item.originalCode === 'NEW ITEM' || item.description === 'Manual Entry') {
                            cat = 'Manual / Added Items';
                        }
                        // Map Types to Display Categories
                        else if (cat === 'Base') {
                            cat = (roomLower.includes('bath') || roomLower.includes('vanity') || roomLower.includes('ensuite') || roomLower.includes('powder')) 
                                ? 'Vanity Cabinets' 
                                : 'Base Cabinets';
                        }
                        else if (cat === 'Wall') cat = 'Wall Cabinets';
                        else if (cat === 'Tall') cat = 'Tall Cabinets';
                        else if (cat === 'Hardware') cat = 'Hinges & Hardware';
                        else if (cat === 'Filler') cat = 'Fillers';
                        else if (cat === 'Finishing' || cat === 'Panel') cat = 'Hinges & Hardware';
                        else if (cat === 'Appliance') cat = 'Appliances';
                        else if (cat === 'Accessory') cat = 'Accessories';
                        else if (cat === 'Modification') cat = 'Modifications';
                        else cat = 'Other Items';

                        if (!acc[cat]) acc[cat] = [];
                        acc[cat].push(item);
                        return acc;
                   }, {} as Record<string, typeof roomGroup.items>);

                   const displayOrder = [
                       'Wall Cabinets', 
                       'Base Cabinets', 
                       'Vanity Cabinets', 
                       'Tall Cabinets', 
                       'Appliances', 
                       'Hinges & Hardware', 
                       'Fillers',
                       'Accessories', 
                       'Modifications',
                       'Other Items',
                       'Manual / Added Items'
                   ];

                   const sortedCats = Object.keys(categorized).sort((a, b) => {
                       const ia = displayOrder.indexOf(a);
                       const ib = displayOrder.indexOf(b);
                       return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                   });

                   return sortedCats.map(category => (
                       <React.Fragment key={category}>
                           <tr className="bg-slate-50/50 border-b border-slate-100">
                               <td colSpan={6} className="px-4 py-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider pl-12 flex items-center gap-2">
                                   <div className="w-1.5 h-1.5 rounded-full bg-slate-300"></div>
                                   {category}
                               </td>
                           </tr>
                           {categorized[category].map(item => (
                                <tr key={item.id} className={`hover:bg-blue-50 group border-b border-slate-100 ${selectedItems.has(item.id) ? 'bg-blue-50' : ''}`}>
                                    <td className="px-3 py-3 text-center">
                                        <input 
                                            type="checkbox" 
                                            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500 h-4 w-4"
                                            checked={selectedItems.has(item.id)}
                                            onChange={() => toggleSelection(item.id)}
                                        />
                                    </td>
                                    <td className="px-6 py-3 text-sm text-slate-900 pl-4">
                                        <DebouncedInput 
                                            className="w-full bg-transparent border-none focus:bg-white focus:ring-1 focus:ring-brand-500 px-1 py-0.5" 
                                            value={item.description} 
                                            onChange={(val: string) => updateProjectItem(item.id, { description: val })}
                                        />
                                        <div className="text-xs text-slate-400 mt-0.5">
                                            {item.width > 0 && `${item.width}" W x `}{item.height}" H x {item.depth}" D
                                        </div>
                                        {item.modifications && item.modifications.length > 0 && (
                                            <div className="mt-1 pl-2 border-l-2 border-slate-200 text-xs text-slate-500">
                                                {item.modifications.map((m, i) => (<div key={i}>+ {m.description}</div>))}
                                            </div>
                                        )}
                                    </td>
                                   <td className="px-6 py-3 text-sm text-slate-500 font-mono">
                                       <DebouncedInput 
                                           className="w-full bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5 font-bold text-slate-800" 
                                           value={item.originalCode} 
                                           onChange={(val: string) => updateProjectItem(item.id, { originalCode: val.toUpperCase() })}
                                       />
                                   </td>
                                   <td className="px-6 py-3 text-sm text-brand-700 font-bold font-mono">
                                       {item.normalizedCode || item.originalCode}
                                   </td>
                                   <td className="px-6 py-3 text-center font-medium">
                                       <DebouncedInput 
                                           type="number" 
                                           className="w-16 text-center bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5" 
                                           value={item.quantity} 
                                           onChange={(val: number) => updateProjectItem(item.id, { quantity: val || 0 })}
                                       />
                                   </td>
                                   <td className="px-4 py-3 text-right">
                                       <button 
                                           type="button" 
                                           onClick={() => deleteProjectItem(item.id)} 
                                           className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors" 
                                           title="Remove Item"
                                       >
                                           <Trash2 className="w-4 h-4"/>
                                       </button>
                                   </td>
                               </tr>
                           ))}
                       </React.Fragment>
                   ));
               })()}
                                       <tr className="bg-white">
                                            <td colSpan={6} className="px-6 py-2 pl-12">
                                                 <Button variant="ghost" size="sm" onClick={() => handleAddItem(roomGroup.room, 'Base')} className="text-brand-600 hover:text-brand-700 hover:bg-brand-50 text-xs flex items-center gap-1">
                                                     <Plus className="w-3 h-3" /> Add Item to {roomGroup.room}
                                                 </Button>
                                            </td>
                                        </tr>
                                   </React.Fragment>
                               )
                               })
                           })
                        </tbody>
                    </table>
                </div>
                
                <div className="flex justify-end pt-2">
                    <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={handleAddRoom} 
                        className="text-slate-600 hover:text-brand-600 border-dashed border-slate-300 bg-slate-50 hover:bg-white transition-all"
                    >
                        <Plus className="w-4 h-4 mr-2" /> Add New Room Group
                    </Button>
                </div>

                {/* Floating Action Bar */}
                {selectedItems.size > 0 && (
                    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-4 animate-in slide-in-from-bottom-4 z-50">
                        <span className="font-bold text-sm">{selectedItems.size} items selected</span>
                        <div className="h-4 w-px bg-slate-700"></div>
                        <button 
                            onClick={handleBulkMove}
                            className="text-sm font-medium hover:text-brand-400 transition-colors flex items-center gap-2"
                        >
                            <ArrowRight className="w-4 h-4" /> Move
                        </button>
                        <button 
                            onClick={handleBulkDelete}
                            className="text-sm font-medium hover:text-red-400 transition-colors flex items-center gap-2"
                        >
                            <Trash2 className="w-4 h-4" /> Delete
                        </button>
                        <button 
                            onClick={() => setSelectedItems(new Set())}
                            className="text-xs text-slate-400 hover:text-white transition-colors ml-2"
                        >
                            Cancel
                        </button>
                    </div>
                )}

                {/* Toast Notification */}
                {toastMessage && (
                    <div className="fixed bottom-6 right-6 bg-slate-900 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-in slide-in-from-bottom-4 z-50">
                        <CheckCircle2 className="w-5 h-5 text-green-400" />
                        <span className="font-medium text-sm">{toastMessage}</span>
                    </div>
                )}
             </div>
        )}
        {step === 2 && (
            <div className="space-y-6">
                <div className="flex items-start gap-3"><Button variant="ghost" size="sm" onClick={handleBack} className="mt-1 shrink-0"><ArrowLeft className="w-5 h-5" /></Button><div><h2 className="text-2xl font-bold text-slate-900">Select Manufacturer</h2><p className="text-slate-500">Connect to a live manufacturer database to pull pricing and specs.</p></div></div>
                
                {/* Dealer Filter */}
                {Array.from(new Set(manufacturers.map(m => m.dealerName).filter(Boolean))).length > 0 && (
                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 mb-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Filter by Dealer / Distributor</label>
                        <select 
                            className="w-full md:w-1/3 p-2 border border-slate-300 rounded text-sm bg-white focus:ring-2 focus:ring-brand-500 outline-none"
                            value={selectedDealer || ''}
                            onChange={(e) => setSelectedDealer(e.target.value || null)}
                        >
                            <option value="">Show All Dealers</option>
                            {Array.from(new Set(manufacturers.map(m => m.dealerName).filter(Boolean))).sort().map(d => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-4">
                    {manufacturers
                        .filter(m => !selectedDealer || m.dealerName === selectedDealer)
                        .map(mfg => {
                        const connecting = isConnecting === mfg.id;
                        return (<div key={mfg.id} className={`group border rounded-xl p-6 transition-all flex flex-col md:flex-row md:items-center justify-between gap-6 ${connecting ? 'border-brand-500 ring-2 ring-brand-100 bg-brand-50' : 'border-slate-200 hover:border-brand-400 hover:shadow-md'}`}><div className="flex items-center gap-6"><div className={`w-20 h-20 rounded-xl flex items-center justify-center font-bold text-2xl transition-colors ${connecting ? 'bg-white text-brand-600 shadow-sm' : 'bg-slate-100 text-slate-400 group-hover:bg-brand-50 group-hover:text-brand-600'}`}>{mfg.name.substring(0,2).toUpperCase()}</div><div><h3 className="font-bold text-xl text-slate-900 flex items-center gap-2">{mfg.name}{connecting && <span className="text-xs bg-brand-200 text-brand-800 px-2 py-0.5 rounded-full animate-pulse">Connecting...</span>}</h3><div className="flex flex-wrap gap-4 mt-2 text-sm text-slate-500"><div className="flex items-center gap-1.5"><Database className="w-4 h-4 text-slate-400" /><span className="font-medium text-slate-700">{(mfg.skuCount || 0).toLocaleString()}</span> SKUs Indexed</div><div className="flex items-center gap-1.5"><Layers className="w-4 h-4 text-slate-400" /><span className="font-medium text-slate-700">{mfg.tiers.length}</span> Pricing Columns</div>{mfg.dealerName && <div className="flex items-center gap-1.5"><Building2 className="w-4 h-4 text-slate-400" /><span className="font-medium text-slate-700">{mfg.dealerName}</span></div>}</div></div></div><div><Button size="lg" onClick={() => handleConnectMfg(mfg)} disabled={!!isConnecting} className={`w-full md:w-auto min-w-[200px] ${connecting ? 'bg-brand-600' : ''}`}>{connecting ? (<><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Fetching Data...</>) : (<><Link2 className="w-4 h-4 mr-2" /> Connect & Load Data</>)}</Button></div></div>);
                    })}
                </div>
            </div>
        )}
        {step === 3 && currentMfg && (
             <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-slate-100 pb-4 gap-4">
                     <div className="flex items-start gap-3"><Button variant="ghost" size="sm" onClick={handleBack} className="mt-1 shrink-0"><ArrowLeft className="w-5 h-5" /></Button><div><h2 className="text-2xl font-bold text-slate-900">Kitchen Specifications</h2><p className="text-slate-500">Configure specifications exactly as per job requirements.</p></div></div>
                     <Button size="lg" onClick={handleSpecsConfirmed} className="gap-2 w-full sm:w-auto">Calculate Final Quote <ArrowRight className="w-4 h-4"/></Button>
                </div>
                {/* --- EXTERIOR DESIGN SECTION --- */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                    <div className="bg-slate-50/80 px-8 py-4 border-b border-slate-200 flex items-center justify-between">
                        <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                            <PaintBucket className="w-5 h-5 text-brand-600"/> Exterior Finishes
                        </h3>
                        <div className="text-xs font-medium text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">Required Selection</div>
                    </div>
                    
                    <div className="p-8 space-y-8">
                        {/* Primary Selection: Collection -> Door Style */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            {/* Collection */}
                            <div className="bg-slate-50 p-6 rounded-lg border border-slate-200 hover:border-brand-300 transition-colors">
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Cabinet Collection / Series</label>
                                {(() => {
                                    const options = groupedOptions['Collection'] || [];
                                    const isSelect = options.length > 0;
                                    return (
                                        <SpecField 
                                            key="Collection"
                                            label="Collection"
                                            type={isSelect ? "select" : "text"} 
                                            options={isSelect ? Array.from(new Set(options.map(o => o.name))).map((name, i) => ({ id: `coll_${i}`, label: name, value: name })) : []}
                                            value={project.specs?.dynamicSelections?.['Collection'] || ''} 
                                            onChange={(v: string) => updateDynamicSelection('Collection', v)} 
                                        />
                                    );
                                })()}
                                <p className="text-xs text-slate-400 mt-2">Select a collection first to see available door styles.</p>
                            </div>

                            {/* Door Style */}
                            <div className={`p-6 rounded-lg border transition-colors ${project.specs?.dynamicSelections?.['Collection'] ? 'bg-white border-brand-200 shadow-sm' : 'bg-slate-50 border-slate-200 opacity-70'}`}>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2 flex justify-between">
                                    <span>Door Style</span>
                                    {project.specs?.dynamicSelections?.['Collection'] && <span className="text-brand-600">Active</span>}
                                </label>
                                {(() => {
                                    let options = groupedOptions['DoorStyle'] || [];
                                    const selectedCollection = project?.specs?.dynamicSelections?.['Collection'];
                                    
                                    if (selectedCollection) {
                                        options = options.filter(o => (o as any).parentCollection === selectedCollection);
                                    } else if (groupedOptions['Collection'] && groupedOptions['Collection'].length > 0) {
                                        options = []; // Hide door styles until collection is picked
                                    }

                                    const isSelect = options.length > 0;
                                    
                                    return (
                                        <SpecField 
                                            key="DoorStyle"
                                            label="Door Style"
                                            type={isSelect ? "select" : "text"} 
                                            options={isSelect ? Array.from(new Set(options.map(o => o.name))).map((name, i) => ({ id: `door_${i}`, label: name, value: name })) : []}
                                            value={project.specs?.dynamicSelections?.['DoorStyle'] || ''} 
                                            onChange={(v: string) => updateDynamicSelection('DoorStyle', v)} 
                                        />
                                    );
                                })()}
                            </div>
                        </div>



                        {/* Secondary Finishes: Wood, Finish, Glaze, etc. */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 pt-4 border-t border-slate-100">
                             {['Wood', 'Finish', 'Paint', 'Stain', 'Glaze'].map(cat => {
                                 const options = groupedOptions[cat] || [];
                                 if (options.length === 0) return null;
                                 
                                 return (
                                    <div key={cat} className="space-y-1">
                                        <label className="text-xs font-bold text-slate-500 uppercase">{cat === 'Wood' ? 'Wood Species' : cat}</label>
                                        <SpecField 
                                            label={cat} 
                                            type="select" 
                                            options={Array.from(new Set(options.map(o => o.name))).map((name, i) => {
                                                const opt = options.find(o => o.name === name);
                                                let label = name;
                                                if (opt && opt.pricingType !== 'included' && opt.price > 0) {
                                                    label += ` (${opt.pricingType === 'percentage' ? '+' + (opt.price * 100).toFixed(0) + '%' : '+$' + opt.price})`;
                                                }
                                                return { id: `${cat}_opt_${i}`, label, value: name };
                                            })}
                                            value={project.specs?.dynamicSelections?.[cat] || ''} 
                                            onChange={(v: string) => updateDynamicSelection(cat, v)} 
                                        />
                                    </div>
                                 );
                             })}
                        </div>
                    </div>
                </div>

                {/* --- ROOM-WISE SPECIFICATIONS --- */}
                {(() => {
                    const rooms = Array.from(new Set(project.items.map(i => i.room || "General")));
                    if (rooms.length > 0) {
                        return (
                             <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-8 animate-in slide-in-from-bottom-4 duration-500 delay-100">
                                <div className="bg-slate-50/80 px-8 py-4 border-b border-slate-200 flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                                        <Layers className="w-5 h-5 text-brand-600"/> Room-Specific Overrides
                                    </h3>
                                    <div className="text-xs font-medium text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">Optional</div>
                                </div>
                                <div className="p-8 space-y-6 bg-slate-50/30">
                                    <p className="text-sm text-slate-500 mb-2">
                                        Use this section to override the global Collection or Door Style for specific rooms (e.g., if the Kitchen is "Elite" but the Laundry is "Standard").
                                    </p>
                                    {rooms.map(roomName => {
                                        const roomSpec = project.roomSpecs?.[roomName] || {};
                                        const roomDyn = roomSpec.dynamicSelections || {};
                                        
                                        // Determine effective collection for this room (Local Override > Global)
                                        const effectiveCollection = roomDyn['Collection'] || project.specs?.dynamicSelections?.['Collection'];

                                        return (
                                            <div key={roomName} className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden p-6 hover:shadow-md transition-shadow">
                                                <div className="flex items-center gap-3 mb-4 pb-2 border-b border-slate-100">
                                                    <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center text-brand-600 font-bold text-xs">
                                                        {roomName.substring(0, 2).toUpperCase()}
                                                    </div>
                                                    <h4 className="font-bold text-slate-800">{roomName}</h4>
                                                </div>
                                                
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                    {/* Room Collection */}
                                                    <div className="space-y-1">
                                                        <label className="text-xs font-bold text-slate-500 uppercase">Collection</label>
                                                        <SpecField 
                                                            label="Collection"
                                                            type="select" 
                                                            options={[
                                                                { id: 'default', label: 'Use Project Default', value: '' },
                                                                ...(groupedOptions['Collection'] || []).map((o, i) => ({ id: `r_coll_${i}`, label: o.name, value: o.name }))
                                                            ]}
                                                            value={roomDyn['Collection'] || ''} 
                                                            onChange={(v: string) => updateRoomDynamicSelection(roomName, 'Collection', v)} 
                                                        />
                                                    </div>

                                                    {/* Room Door Style */}
                                                    <div className="space-y-1">
                                                        <label className="text-xs font-bold text-slate-500 uppercase">Door Style</label>
                                                        {(() => {
                                                            let options = groupedOptions['DoorStyle'] || [];
                                                            // Filter based on EFFECTIVE collection for this room
                                                            if (effectiveCollection) {
                                                                options = options.filter(o => (o as any).parentCollection === effectiveCollection);
                                                            } else if (groupedOptions['Collection'] && groupedOptions['Collection'].length > 0) {
                                                                options = [];
                                                            }
                                                            
                                                            return (
                                                                <SpecField 
                                                                    label="Door Style"
                                                                    type="select" 
                                                                    options={[
                                                                        { id: 'default', label: 'Use Project Default', value: '' },
                                                                        ...Array.from(new Set(options.map(o => o.name))).map((name, i) => ({ id: `r_door_${i}`, label: name, value: name }))
                                                                    ]}
                                                                    value={roomDyn['DoorStyle'] || ''} 
                                                                    onChange={(v: string) => updateRoomDynamicSelection(roomName, 'DoorStyle', v)} 
                                                                />
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                             </div>
                        )
                    }
                })()}
             </div>
        )}
        
        {step === 4 && project.pricing && (
            <div className="space-y-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 print:hidden">
                    <div className="flex items-start gap-3"><Button variant="ghost" size="sm" onClick={handleBack} className="mt-1 shrink-0"><ArrowLeft className="w-5 h-5" /></Button><div><h2 className="text-2xl font-bold text-slate-900">Bill of Materials</h2><p className="text-slate-500">Review calculated pricing based on {project.specs?.priceGroup}</p></div></div>
                    <div className="flex gap-2 w-full sm:w-auto"><Button variant="outline" onClick={() => setStep(3)} className="flex-1 sm:flex-none">Edit Specs</Button><Button onClick={() => setStep(5)} className="flex-1 sm:flex-none">Next: Details</Button></div>
                </div>

                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 flex flex-wrap gap-6 text-sm">
                    <div><span className="text-slate-500 font-medium">Manufacturer:</span> <span className="font-bold">{project.specs?.manufacturer}</span></div>
                    <div><span className="text-slate-500 font-medium">Line:</span> <span className="font-bold">{project.specs?.lineType || 'All'}</span></div>
                    <div><span className="text-slate-500 font-medium">Series:</span> <span className="font-bold text-brand-700">{project.specs?.seriesName || project.specs?.priceGroup}</span></div>
                    <div><span className="text-slate-500 font-medium">Door:</span> <span className="font-bold">{project.specs?.wallDoorStyle}</span></div>
                    <div><span className="text-slate-500 font-medium">Finish:</span> <span className="font-bold">{project.specs?.finishColor}</span></div>
                </div>

                <div className="flex flex-col lg:flex-row gap-6">
                    <div className="flex-1 overflow-x-auto border border-slate-200 rounded-lg shadow-sm bg-white">
                        
                        {/* --- NEW: CATALOG ITEM ADDER --- */}
                        {/* REMOVED: Catalog Item Adder Dropdowns as per user request */}

                        {(() => {
                            // 1. Separate Items by Category
                            // Cabinet Items: Everything NOT Hardware, Finishing, or Appliance
                            const cabinetItems = project.pricing.filter(i => !['Appliance', 'Hardware', 'Finishing'].includes(i.type));
                            
                            // Hardware: Hinges, Glides, etc.
                            const hardwareItems = project.pricing.filter(i => i.type === 'Hardware');
                            
                            // Finishing: Touch Up, Putty, Paint, Stain, etc.
                            const finishingItems = project.pricing.filter(i => i.type === 'Finishing');
                            
                            // Appliances: Excluded
                            const applianceItems = project.pricing.filter(i => i.type === 'Appliance');

                            // 2. Group Cabinets by Room
                            // Default to "General" only if Room is missing
                            const groups: Record<string, PricingLineItem[]> = {};
                            cabinetItems.forEach(item => {
                                let room = item.room || "General";
                                // Clean up room names if needed (e.g. "Kitchen 1" vs "Kitchen")
                                if (room.toLowerCase() === 'unknown') room = "General";
                                
                                if (!groups[room]) groups[room] = [];
                                groups[room].push(item);
                            });

                            // 3. Render Cabinet Groups
                            // SORTED BY PAGE NUMBER (Min Page of items in group)
                            const sortedRoomEntries = Object.entries(groups).sort((a, b) => {
                                const [nameA, itemsA] = a;
                                const [nameB, itemsB] = b;
                                
                                // Get min page for each room
                                const minPageA = Math.min(...itemsA.map(i => (i as any).sourcePage || 999));
                                const minPageB = Math.min(...itemsB.map(i => (i as any).sourcePage || 999));
                                
                                if (minPageA !== minPageB) return minPageA - minPageB;
                                return nameA.localeCompare(nameB);
                            });

                            const cabinetSections = sortedRoomEntries.map(([roomName, roomItems]) => {
                                // Sub-Grouping Logic (Same as PDF)
                                const categorized: Record<string, PricingLineItem[]> = {};
                                const roomLower = roomName.toLowerCase();
                                
                                roomItems.forEach(item => {
                                    let cat = item.type as string;
                                    
                                    // Map Types to Display Categories
                                    if (cat === 'Vanity') {
                                        cat = 'Vanity Cabinets';
                                    }
                                    else if (cat === 'Base') {
                                        cat = (roomLower.includes('bath') || roomLower.includes('vanity') || roomLower.includes('ensuite') || roomLower.includes('powder')) 
                                            ? 'Vanity Cabinets' 
                                            : 'Base Cabinets';
                                    }
                                    else if (cat === 'Wall') cat = 'Wall Cabinets';
                                    else if (cat === 'Tall') cat = 'Tall Cabinets';
                                    else if (cat === 'Hardware') cat = 'Hinges & Hardware';
                                    else if (cat === 'Filler') cat = 'Fillers';
                                    else if (cat === 'Finishing' || cat === 'Panel') cat = 'Finishing & Panels';
                                    else if (cat === 'Appliance') cat = 'Appliances';
                                    else if (cat === 'Accessory') cat = 'Accessories';
                                    else if (cat === 'Modification') cat = 'Modifications';
                                    
                                    if (!categorized[cat]) categorized[cat] = [];
                                    categorized[cat].push(item);
                                });

                                // Define Sort Order
                                const categoryOrder = [
                                    'Wall Cabinets', 
                                    'Base Cabinets', 
                                    'Vanity Cabinets', 
                                    'Tall Cabinets', 
                                    'Fillers',
                                    'Finishing & Panels',
                                    'Hinges & Hardware', 
                                    'Appliances', 
                                    'Accessories', 
                                    'Modifications'
                                ];

                                const sortedCategories = Object.keys(categorized).sort((a, b) => {
                                    const idxA = categoryOrder.indexOf(a);
                                    const idxB = categoryOrder.indexOf(b);
                                    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                                    if (idxA !== -1) return -1;
                                    if (idxB !== -1) return 1;
                                    return a.localeCompare(b);
                                });

                                return (
                                <div key={roomName} className="mb-8 border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                                    <div className="bg-slate-100 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                                        <div className="flex items-center gap-4">
                                            <div className="flex items-center gap-2">
                                                <Layers className="w-5 h-5 text-brand-600" />
                                                <h3 className="font-bold text-lg text-slate-800">{roomName}</h3>
                                                <span className="bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full text-xs font-medium">{roomItems.length} items</span>
                                            </div>
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className="text-slate-400 font-medium uppercase tracking-wide">Markup Factor:</span>
                                                <DebouncedInput
                                                    type="number"
                                                    step="0.01"
                                                    className={`w-16 px-1 py-0.5 border rounded text-center ${financials.roomFactors?.[roomName] ? 'border-brand-300 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 bg-white text-slate-600'}`}
                                                    placeholder={financials.pricingFactor.toString()}
                                                    value={financials.roomFactors?.[roomName] ?? ''}
                                                    onChange={(val: number | string) => {
                                                        const numVal = val === '' ? null : Number(val);
                                                        updateRoomFactor(roomName, numVal);
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Subtotal</div>
                                            <div className="text-lg font-bold text-slate-900">${roomItems.reduce((acc, i) => acc + i.totalPrice, 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    
                                    <table className="min-w-full divide-y divide-slate-200">
                                        <thead className="bg-slate-50 text-slate-500">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider">#</th>
                                                <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider">Code</th>
                                                <th className="px-4 py-2 text-center text-xs font-bold uppercase tracking-wider">Qty</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider">Unit Price</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider">Total</th>
                                                <th className="px-4 py-2 w-10"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-slate-100">
                                            {sortedCategories.map(cat => (
                                                <React.Fragment key={cat}>
                                                    {/* Category Header */}
                                                    <tr className="bg-slate-50/80">
                                                        <td colSpan={7} className="px-4 py-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">
                                                            {cat}
                                                        </td>
                                                    </tr>
                                                    {categorized[cat].map((item, index) => (
                                                        <tr key={item.id} className={`hover:bg-slate-50 ${item.totalPrice === 0 ? 'bg-red-50/30' : ''}`}>
                                                            <td className="px-4 py-3 text-slate-400 text-sm">{index + 1}</td>
                                                            <td className="px-4 py-3 font-mono font-bold text-slate-800 text-sm">
                                                                <DebouncedInput 
                                                                    className="w-full bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5 font-bold text-slate-800" 
                                                                    value={item.originalCode} 
                                                                    onChange={(val: string) => handleBOMUpdate(item.id, 'code', val)}
                                                                />
                                                                {item.originalCode !== item.normalizedCode && (<div className="text-xs text-slate-400 font-normal mt-0.5">Norm: {item.normalizedCode}</div>)}
                                                                
                                                                {/* Dimensions & Options moved here */}
                                                                <div className="text-xs text-slate-500 mt-0.5 font-normal">{item.width}"W x {item.height}"H x {item.depth}"D</div>
                                                                {item.appliedOptions && item.appliedOptions.length > 0 && (
                                                                    <div className="mt-1 flex flex-wrap gap-1">
                                                                        {item.appliedOptions.map((opt, i) => (
                                                                            <span key={i} className="text-[10px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded border border-green-100 font-sans font-normal">+{opt.name} (${opt.price})</span>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                <div className="text-[10px] text-slate-400 mt-1 truncate max-w-[150px] font-sans font-normal" title={item.source}>{item.source}</div>
                                                            </td>
                                                            <td className="px-4 py-3 text-center text-sm font-medium">
                                                                <DebouncedInput 
                                                                    type="number" 
                                                                    className="w-16 text-center bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5" 
                                                                    value={item.quantity} 
                                                                    onChange={(val: number) => handleBOMUpdate(item.id, 'quantity', val)}
                                                                />
                                                            </td>
                                                            <td className="px-4 py-3 text-right text-sm">
                                                                <div className="flex items-center justify-end gap-1">
                                                                    <span className="text-slate-400 text-xs">$</span>
                                                                    <DebouncedInput 
                                                                        type="number" 
                                                                        className={`w-20 text-right bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5 ${item.finalUnitPrice === 0 ? 'text-red-600 font-bold' : 'text-slate-600'}`}
                                                                        value={item.finalUnitPrice} 
                                                                        onChange={(val: number) => handleBOMUpdate(item.id, 'price', val)}
                                                                    />
                                                                </div>
                                                                {item.finalUnitPrice === 0 && (
                                                                    <div className="text-[10px] text-red-500 mt-1 text-right font-bold flex items-center justify-end gap-1"><AlertCircle className="w-3 h-3"/> CHECK PRICE</div>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-3 text-right text-sm font-bold">{item.totalPrice === 0 ? (<span className="text-red-600">$0.00</span>) : (<span className="text-slate-900">${item.totalPrice.toLocaleString()}</span>)}</td>
                                                            <td className="px-4 py-3 text-center">
                                                                <button 
                                                                    onClick={() => deleteProjectItem(item.id)}
                                                                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                                                    title="Remove Item"
                                                                >
                                                                    <Trash2 className="w-4 h-4" />
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </React.Fragment>
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className="p-3 bg-slate-50 border-t border-slate-200">
                                         <Button variant="ghost" onClick={() => addBOMItem(undefined, roomName)} className="text-brand-600 hover:text-brand-700 hover:bg-brand-50 w-full flex justify-center items-center gap-2 border border-dashed border-brand-200">
                                             <Plus className="w-4 h-4" /> Add Item to {roomName}
                                         </Button>
                                    </div>
                                </div>
                            );
                        });

                            // 4. Render Hardware Section
                            const hardwareSection = hardwareItems.length > 0 ? (
                                <div key="hardware-section" className="mb-8 border border-orange-200 rounded-lg overflow-hidden shadow-sm">
                                    <div className="bg-orange-50 px-4 py-3 border-b border-orange-200 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <Hammer className="w-5 h-5 text-orange-600" />
                                            <h3 className="font-bold text-lg text-orange-900">Hardware & Mechanisms</h3>
                                            <span className="bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full text-xs font-medium">{hardwareItems.length} items</span>
                                        </div>
                                        <span className="text-sm font-bold text-orange-900">
                                            Subtotal: <span className="text-lg text-orange-950">${hardwareItems.reduce((acc, i) => acc + i.totalPrice, 0).toLocaleString()}</span>
                                        </span>
                                    </div>
                                    <table className="min-w-full divide-y divide-orange-100">
                                        <thead className="bg-orange-50/50 text-orange-500">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-bold uppercase">Code</th>
                                                <th className="px-4 py-2 text-center text-xs font-bold uppercase">Qty</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase">Price</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase">Total</th>
                                                <th className="px-4 py-2 w-10"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-orange-50">
                                            {hardwareItems.map((item, index) => (
                                                <tr key={item.id}>
                                                    <td className="px-4 py-2 text-sm text-slate-800 font-bold font-mono">
                                                        {item.originalCode}
                                                        {item.description && item.description !== item.originalCode && (
                                                            <div className="text-[10px] text-slate-400 font-sans font-normal">{item.description}</div>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2 text-center text-sm">{item.quantity}</td>
                                                    <td className="px-4 py-2 text-right text-sm">${item.finalUnitPrice.toLocaleString()}</td>
                                                    <td className="px-4 py-2 text-right text-sm font-bold">${item.totalPrice.toLocaleString()}</td>
                                                    <td className="px-4 py-2 text-center">
                                                        <button onClick={() => deleteProjectItem(item.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3"/></button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : null;

                            // 5. Render Finishing Section (NEW)
                            const finishingSection = finishingItems.length > 0 ? (
                                <div key="finishing-section" className="mb-8 border border-purple-200 rounded-lg overflow-hidden shadow-sm">
                                    <div className="bg-purple-50 px-4 py-3 border-b border-purple-200 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="p-1 bg-purple-100 rounded text-purple-600"><PaintBucket className="w-4 h-4" /></div>
                                            <h3 className="font-bold text-lg text-purple-900">Finishing & Touch Up</h3>
                                            <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full text-xs font-medium">{finishingItems.length} items</span>
                                        </div>
                                        <span className="text-sm font-bold text-purple-900">
                                            Subtotal: <span className="text-lg text-purple-950">${finishingItems.reduce((acc, i) => acc + i.totalPrice, 0).toLocaleString()}</span>
                                        </span>
                                    </div>
                                    <table className="min-w-full divide-y divide-purple-100">
                                        <thead className="bg-purple-50/50 text-purple-500">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-bold uppercase">Code</th>
                                                <th className="px-4 py-2 text-center text-xs font-bold uppercase">Qty</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase">Price</th>
                                                <th className="px-4 py-2 text-right text-xs font-bold uppercase">Total</th>
                                                <th className="px-4 py-2 w-10"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-purple-50">
                                            {finishingItems.map((item, index) => (
                                                <tr key={item.id}>
                                                    <td className="px-4 py-2 text-sm text-slate-800 font-bold font-mono">
                                                        {item.originalCode}
                                                        {item.description && item.description !== item.originalCode && (
                                                            <div className="text-[10px] text-slate-400 font-sans font-normal">{item.description}</div>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2 text-center text-sm">{item.quantity}</td>
                                                    <td className="px-4 py-2 text-right text-sm">${item.finalUnitPrice.toLocaleString()}</td>
                                                    <td className="px-4 py-2 text-right text-sm font-bold">${item.totalPrice.toLocaleString()}</td>
                                                    <td className="px-4 py-2 text-center">
                                                        <button onClick={() => deleteProjectItem(item.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3"/></button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : null;

                            // 6. Render Appliances Section (Excluded Items)
                            const applianceSection = applianceItems.length > 0 ? (
                                <div key="appliance-section" className="mb-8 border border-slate-200 border-dashed rounded-lg overflow-hidden opacity-75">
                                    <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <AlertCircle className="w-4 h-4 text-slate-400" />
                                            <h3 className="font-bold text-slate-600">Appliances (Not Quoted)</h3>
                                            <span className="bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full text-xs font-medium">{applianceItems.length} found</span>
                                        </div>
                                    </div>
                                    <div className="p-4 bg-slate-50/50 flex flex-wrap gap-2">
                                        {applianceItems.map(item => (
                                            <span key={item.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white border border-slate-200 text-xs font-medium text-slate-600 shadow-sm">
                                                {item.originalCode} 
                                                <span className="text-slate-400">({item.quantity})</span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ) : null;

                            return [
                                ...cabinetSections, 
                                hardwareSection, 
                                finishingSection,
                                applianceSection
                            ];
                        })()}
                    </div>
                    
                    <div className="w-full lg:w-80 shrink-0 space-y-4">
                        <div className="bg-slate-50 p-5 rounded-xl border border-slate-200">
                             <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4"><Calculator className="w-4 h-4"/> Quote Financials</h3>
                             <div className="space-y-4">
                                 {/* NEW PRICING LOGIC */}
                                 <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg space-y-3">
                                     <h4 className="text-[10px] font-bold text-blue-800 uppercase tracking-wider mb-2">Cost & Margin Settings</h4>
                                     
                                     <div>
                                         <label className="text-xs font-bold text-slate-500 uppercase">Pricing Factor (Cost)</label>
                                         <div className="relative mt-1">
                                             <DebouncedInput 
                                                type="number" step="0.01" 
                                                className="w-full pl-3 pr-3 py-2 border border-blue-200 rounded text-sm focus:ring-2 focus:ring-blue-500" 
                                                value={financials.pricingFactor} 
                                                onChange={(val: number) => updateFinancials('pricingFactor', val || 1.0)} 
                                             />
                                             <div className="text-[10px] text-slate-400 mt-1">Ex: 0.45 = 55% Off List</div>
                                         </div>
                                     </div>

                                     <div>
                                         <label className="text-xs font-bold text-slate-500 uppercase">Target Margin (%)</label>
                                         <div className="relative mt-1">
                                             <DebouncedInput 
                                                type="number" step="1" 
                                                className="w-full pl-3 pr-8 py-2 border border-blue-200 rounded text-sm focus:ring-2 focus:ring-blue-500" 
                                                value={financials.globalMargin} 
                                                onChange={(val: number) => updateFinancials('globalMargin', val || 0)} 
                                             />
                                             <span className="absolute right-3 top-2 text-slate-400 text-sm">%</span>
                                         </div>
                                     </div>
                                 </div>

                                 <div className="border-t border-slate-200 my-2"></div>

                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Add'l Discount (%)</label><div className="relative mt-1"><DebouncedInput type="number" min="0" max="100" className="w-full pl-3 pr-8 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.discountRate} onChange={(val: number) => updateFinancials('discountRate', val || 0)} /><span className="absolute right-3 top-2 text-slate-400 text-sm">%</span></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Sales Tax Rate (%)</label><div className="relative mt-1"><DebouncedInput type="number" min="0" max="100" step="0.1" className="w-full pl-3 pr-8 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.taxRate} onChange={(val: number) => updateFinancials('taxRate', val || 0)} /><span className="absolute right-3 top-2 text-slate-400 text-sm">%</span></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Freight / Shipping ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.shippingCost} onChange={(val: number) => updateFinancials('shippingCost', val || 0)} /></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Fuel Surcharge ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.fuelSurcharge} onChange={(val: number) => updateFinancials('fuelSurcharge', val || 0)} /></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Misc Charges ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.miscCharge} onChange={(val: number) => updateFinancials('miscCharge', val || 0)} /></div></div>
                                 
                                 <div className="pt-4 border-t border-slate-200 mt-4">
                                     {(() => {
                                         // Use the updated logic: totalPrice IS the Sell Price (calculated with Margin)
                                         const sellTotal = project.pricing.reduce((acc, i) => acc + i.totalPrice, 0);
                                         
                                         // Cost Calculation for Display (Optional)
                                         const costTotal = project.pricing.reduce((acc, i) => acc + ((i as any).unitCost || 0) * i.quantity, 0);
                                         const profit = sellTotal - costTotal;
                                         const margin = sellTotal > 0 ? (profit / sellTotal) * 100 : 0;

                                         // Additional Discount (Dealer Discount) applies to Sell Price
                                         const discountAmount = sellTotal * (financials.discountRate / 100);
                                         const postDiscount = sellTotal - discountAmount;
                                         const taxAmount = postDiscount * (financials.taxRate / 100);
                                         const grandTotal = postDiscount + financials.shippingCost + financials.fuelSurcharge + financials.miscCharge + taxAmount;
                                         
                                         return (
                                             <>
                                                 <div className="mb-4 pb-4 border-b border-dashed border-slate-200">
                                                     <div className="flex justify-between text-xs mb-1 text-slate-400"><span>Est. Mfg Cost:</span><span>${costTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                     <div className="flex justify-between text-xs mb-1 text-slate-400"><span>Est. Profit:</span><span className="text-green-600">${profit.toLocaleString(undefined, {minimumFractionDigits: 2})} ({margin.toFixed(1)}%)</span></div>
                                                 </div>

                                                 <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Sell Price Subtotal:</span><span className="font-medium">${sellTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 {financials.discountRate > 0 && <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Add'l Discount ({financials.discountRate}%):</span><span className="font-medium text-red-600">- ${discountAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                 
                                                 {/* Actual Price (Product Only) */}
                                                 <div className="flex justify-between text-sm mb-2 pt-2 border-t border-slate-100 font-bold text-slate-700"><span className="">Actual Price:</span><span className="">${postDiscount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 
                                                 {/* Fees & Taxes Section */}
                                                 {(financials.taxRate > 0 || financials.shippingCost > 0 || financials.fuelSurcharge > 0 || financials.miscCharge > 0) && (
                                                     <div className="my-3 py-2 bg-slate-50 rounded px-2 text-xs space-y-1 border border-slate-100">
                                                         {financials.taxRate > 0 && <div className="flex justify-between text-slate-500"><span>Tax ({financials.taxRate}%):</span><span>${taxAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                         {financials.shippingCost > 0 && <div className="flex justify-between text-slate-500"><span>Shipping:</span><span>${financials.shippingCost.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                         {financials.fuelSurcharge > 0 && <div className="flex justify-between text-slate-500"><span>Fuel Surcharge:</span><span>${financials.fuelSurcharge.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                         {financials.miscCharge > 0 && <div className="flex justify-between text-slate-500"><span>Misc Charges:</span><span>${financials.miscCharge.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                     </div>
                                                 )}

                                                 <div className="flex justify-between text-xl font-extrabold text-brand-700 mt-3 pt-3 border-t-2 border-slate-200"><span>Grand Total:</span><span>${grandTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                             </>
                                         );
                                     })()}
                                 </div>
                             </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {step === 5 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-slate-100 pb-4 gap-4">
                    <div className="flex items-start gap-3"><Button variant="ghost" size="sm" onClick={handleBack} className="mt-1 shrink-0"><ArrowLeft className="w-5 h-5" /></Button><div><h2 className="text-2xl font-bold text-slate-900">Order Details</h2><p className="text-slate-500">Finalize customer and delivery information for the official quote.</p></div></div>
                    <Button onClick={handleOrderDetailsSubmit} className="w-full sm:w-auto">Finalize Quote <ArrowRight className="w-4 h-4 ml-2" /></Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {/* Customer Info */}
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4"><User className="w-5 h-5 text-brand-600"/> Customer Details</h3>
                        <div className="space-y-4">
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Name</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.name} onChange={e => setCustomerDetails({...customerDetails, name: e.target.value})} placeholder="Full Name" /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Phone</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.phone} onChange={e => setCustomerDetails({...customerDetails, phone: e.target.value})} placeholder="(555) 123-4567" /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Email</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.email} onChange={e => setCustomerDetails({...customerDetails, email: e.target.value})} placeholder="client@example.com" /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Address</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.address} onChange={e => setCustomerDetails({...customerDetails, address: e.target.value})} placeholder="Street Address" /></div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-1"><label className="text-xs font-bold text-slate-500 uppercase">City</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.city} onChange={e => setCustomerDetails({...customerDetails, city: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">State</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.state} onChange={e => setCustomerDetails({...customerDetails, state: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">Zip</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={customerDetails.zip} onChange={e => setCustomerDetails({...customerDetails, zip: e.target.value})} /></div>
                            </div>
                        </div>
                    </div>

                    {/* Dealer Info */}
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4"><Building2 className="w-5 h-5 text-brand-600"/> Dealer Details</h3>
                        <div className="space-y-4">
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Company Name</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.name} onChange={e => setDealerDetails({...dealerDetails, name: e.target.value})} /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Contact Person</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.contactPerson} onChange={e => setDealerDetails({...dealerDetails, contactPerson: e.target.value})} /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Phone</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.phone} onChange={e => setDealerDetails({...dealerDetails, phone: e.target.value})} /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Address</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.address} onChange={e => setDealerDetails({...dealerDetails, address: e.target.value})} /></div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-1"><label className="text-xs font-bold text-slate-500 uppercase">City</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.city} onChange={e => setDealerDetails({...dealerDetails, city: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">State</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.state} onChange={e => setDealerDetails({...dealerDetails, state: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">Zip</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={dealerDetails.zip} onChange={e => setDealerDetails({...dealerDetails, zip: e.target.value})} /></div>
                            </div>
                        </div>
                    </div>

                    {/* Delivery Info */}
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4"><Truck className="w-5 h-5 text-brand-600"/> Delivery Location</h3>
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 mb-2">
                                <input type="checkbox" id="sameAsCust" className="rounded text-brand-600" 
                                    onChange={(e) => {
                                        if (e.target.checked) setDeliveryDetails({...customerDetails});
                                        else setDeliveryDetails({name: '', address: '', city: '', state: '', zip: '', phone: ''});
                                    }}
                                /> 
                                <label htmlFor="sameAsCust" className="text-sm text-slate-600">Same as Customer</label>
                            </div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Contact Name</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={deliveryDetails.name} onChange={e => setDeliveryDetails({...deliveryDetails, name: e.target.value})} /></div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Address</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={deliveryDetails.address} onChange={e => setDeliveryDetails({...deliveryDetails, address: e.target.value})} /></div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-1"><label className="text-xs font-bold text-slate-500 uppercase">City</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={deliveryDetails.city} onChange={e => setDeliveryDetails({...deliveryDetails, city: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">State</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={deliveryDetails.state} onChange={e => setDeliveryDetails({...deliveryDetails, state: e.target.value})} /></div>
                                <div><label className="text-xs font-bold text-slate-500 uppercase">Zip</label><input className="w-full p-2 border border-slate-300 rounded text-sm" value={deliveryDetails.zip} onChange={e => setDeliveryDetails({...deliveryDetails, zip: e.target.value})} /></div>
                            </div>
                            <div><label className="text-xs font-bold text-slate-500 uppercase">Site Notes / Gate Code</label><input className="w-full p-2 border border-slate-300 rounded text-sm" placeholder="e.g. Call before arrival" /></div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {step === 6 && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-500 py-12">
                
                 <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mb-6 shadow-lg animate-bounce">
                      <CheckCircle2 className="w-12 h-12 text-green-600" />
                 </div>
                 
                 <h2 className="text-4xl font-extrabold text-slate-900 mb-2">Quotation Ready!</h2>
                 <p className="text-slate-500 text-lg mb-8 max-w-md text-center">
                    Your quote has been generated with 
                    <span className="font-bold text-slate-800"> {project.pricing?.filter(i => i.totalPrice > 0).length} items </span>
                    totaling
                    <span className="font-bold text-slate-800"> ${((project.pricing?.reduce((acc, i) => acc + i.totalPrice, 0) || 0) * (1 - (financials.discountRate/100)) + financials.shippingCost + financials.fuelSurcharge).toLocaleString(undefined, {maximumFractionDigits:0})}</span>.
                 </p>

                 <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                     <Button size="lg" onClick={() => handleDownloadPDF()} className="w-full shadow-xl shadow-brand-500/20 py-6 text-lg h-auto flex-col gap-1">
                        <div className="flex items-center gap-2"><DownloadCloud className="w-6 h-6" /> Download PDF</div>
                        <span className="text-xs font-normal opacity-90">Official Quote Format</span>
                     </Button>
                     <Button size="lg" variant="outline" onClick={() => handleDownloadPDF(true)} className="w-full shadow-sm py-6 text-lg h-auto flex-col gap-1 border-dashed">
                        <div className="flex items-center gap-2"><FileText className="w-6 h-6" /> Summary PDF</div>
                        <span className="text-xs font-normal opacity-70">Room Totals Only</span>
                     </Button>
                 </div>
                 
                 <div className="flex gap-4 mt-8">
                     <Button variant="ghost" onClick={handleBack} className="text-slate-500">
                        <ArrowLeft className="w-4 h-4 mr-2"/> Back to Details
                     </Button>
                     <Button variant="ghost" onClick={() => navigate('/')} className="text-slate-500">
                        Start New Quote
                     </Button>
                 </div>
                 
                 <div className="mt-12 text-center text-sm text-slate-400">
                     <p>Project ID: <span className="font-mono">{project.id}</span></p>
                 </div>
            </div>
        )}

      </div>
    </div>
  );
};