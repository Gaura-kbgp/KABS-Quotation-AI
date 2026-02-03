import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  UploadCloud, CheckCircle2, ChevronRight, FileOutput, 
  Settings2, DollarSign, Printer, ArrowRight, AlertCircle, Edit2, AlertTriangle, Info,
  ArrowLeft, Layers, Package, RefreshCw, AlertOctagon, Check, Tags, PenTool, Database, Server, Link2, DownloadCloud, FileText,
  PaintBucket, Hammer, Shield, Grid3X3, Trash2, Calculator, Truck, User, Building2, MapPin
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

  // Financial State Local (synced with project)
  const [financials, setFinancials] = useState<ProjectFinancials>({
      taxRate: 0,
      shippingCost: 0,
      discountRate: 0,
      fuelSurcharge: 0,
      miscCharge: 0
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

  const updateProject = async (updates: Partial<Project>) => {
    if (!project) return;
    const updated = { ...project, ...updates };
    setProject(updated);
    await storage.saveActiveProject(updated);
  };

  const updateFinancials = (field: keyof ProjectFinancials, value: number) => {
      const newFin = { ...financials, [field]: value };
      setFinancials(newFin);
      updateProject({ financials: newFin });
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
      // Removed window.confirm to allow immediate deletion as requested
      const newItems = project.items.filter(item => item.id !== itemId);
      updateProject({ items: newItems });
  };

  const handleBack = () => {
      if (step > 0) {
          setStep(step - 1);
      } else {
          navigate('/');
      }
  };

  const getGroupedItems = <T extends CabinetItem>(items: T[]) => {
    const groups: Record<string, T[]> = {};
    const standardOrder: CabinetType[] = ['Base', 'Wall', 'Tall', 'Filler', 'Panel', 'Accessory', 'Modification'];
    items.forEach(item => {
      let t = item.type || 'Base';
      if (!standardOrder.includes(t)) t = 'Accessory';
      if (!groups[t]) groups[t] = [];
      groups[t].push(item);
    });
    return standardOrder
      .filter(type => groups[type] && groups[type].length > 0)
      .map(type => ({
        type,
        items: groups[type],
        totalQty: groups[type].reduce((sum, i) => sum + i.quantity, 0)
      }));
  };

  const generatePDFDocument = (proj: Project): jsPDF => {
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
    doc.text("Midland", 45, 20);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text("A Division of Koch Cabinets", 47, 25);

    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("Order", 170, 18, { align: 'right' });
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const headerX = 170;
    let headerY = 24;
    doc.text("111 North 1St. St.", headerX, headerY, { align: 'right' }); headerY += 4;
    doc.text("Seneca KS, 66538", headerX, headerY, { align: 'right' }); headerY += 4;
    doc.text("Phone: 877-540-5624", headerX, headerY, { align: 'right' }); headerY += 4;
    doc.text("Email: orders@kochcabinet.com", headerX, headerY, { align: 'right' });

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
    doc.text("Cabinet Line:", c1, sY); doc.text(s.lineType || "Midland", v1, sY);
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

    // --- PRODUCTS HEADER ---
    doc.setFillColor(230, 230, 230);
    doc.rect(leftMargin, yPos, boxWidth, 6, 'FD');
    doc.setFont("helvetica", "bold");
    doc.text(`Products for Kitchen: ${proj.name || 'Quote'}`, leftMargin + 2, yPos + 4.5);

    // --- TABLE GENERATION ---
    const tableBody: any[] = [];
    validItems.forEach((item, index) => {
        const itemNum = index + 1;
        const desc = item.width > 0 
            ? `${item.description} (${item.width}"W x ${item.height}"H x ${item.depth}"D)`
            : item.description;

        tableBody.push([
            itemNum.toString(),
            item.quantity.toString(),
            item.originalCode,
            desc,
            `$${item.totalPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`
        ]);

        if (item.modifications) {
            item.modifications.forEach((mod, mIndex) => {
                tableBody.push([
                    ``,
                    '',
                    mod.description.includes('FINISH END') ? (mod.description.includes('Left') ? 'FEL' : 'FER') : 'MOD',
                    `${mod.description}`,
                    `$${(mod.price || 0).toFixed(2)}`
                ]);
            });
        }
        
        if (item.appliedOptions) {
            let modCounter = (item.modifications?.length || 0) + 1;
            item.appliedOptions.forEach((opt) => {
                tableBody.push([
                    ``,
                    '',
                    'OPT',
                    `${opt.name}`,
                    `$${opt.price.toFixed(2)}`
                ]);
                modCounter++;
            });
        }
    });

    autoTable(doc, {
        startY: yPos + 6,
        head: [['Item', 'Qty.', 'Product Code', 'Description', 'Price']],
        body: tableBody,
        theme: 'plain',
        styles: { fontSize: 8, cellPadding: 2, lineColor: [200, 200, 200], lineWidth: 0.1, valign: 'middle' },
        headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', lineWidth: 0.1, lineColor: [200, 200, 200] },
        columnStyles: {
            0: { cellWidth: 10, halign: 'center' },
            1: { cellWidth: 10, halign: 'center' },
            2: { cellWidth: 35, fontStyle: 'bold' },
            3: { cellWidth: 97 },
            4: { cellWidth: 30, halign: 'right' }
        },
        margin: { left: 14, right: 14, top: 20, bottom: 20 },
        didParseCell: (data) => {
             if (data.section === 'body' && data.column.index === 4) {
                 const text = data.cell.raw as string;
                 if (text.includes('CHECK PRICE')) {
                     data.cell.styles.textColor = [220, 38, 38];
                     data.cell.styles.fontStyle = 'bold';
                 }
            }
        }
    });

    // --- TOTALS ---
    const subTotal = validItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discountAmount = subTotal * (fin.discountRate / 100);
    const postDiscount = subTotal - discountAmount;
    const taxAmount = postDiscount * (fin.taxRate / 100);
    const grandTotal = postDiscount + taxAmount + fin.shippingCost + fin.fuelSurcharge + fin.miscCharge;

    // Fix for Multi-page download:
    // Check if there is enough space for the summary on the current page.
    let finalY = (doc as any).lastAutoTable.finalY;
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
    doc.text("Kitchen Sub Total", 110, finalY + 5.5);
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

  const handleDownloadPDF = () => {
      if (!project) return;
      try {
          const doc = generatePDFDocument(project);
          doc.save(`Order_${project.id.substring(0,6)}.pdf`);
      } catch (err) {
          console.error("PDF Generation Failed", err);
          alert("Failed to generate PDF. Please try again or reduce item count.");
      }
  };

  const handleOrderDetailsSubmit = () => {
      updateProject({ customerDetails, dealerDetails, deliveryDetails });
      setStep(6);
  };

  // ... (Keep existing handleFileUpload, handleConfirmExtraction, handleConnectMfg, handleSpecsConfirmed, updateSpec, toggleOption)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

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

        setLoadingMessage("AI Vision Analyzing Plan (This may take 30-60s)...");
        const result = await analyzePlan(file, nkbaRules?.data);
        
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

  const handleConfirmExtraction = () => setStep(2);

  const handleConnectMfg = async (mfg: Manufacturer) => {
    setSelectedMfgId(mfg.id);
    setIsConnecting(mfg.id);
    setLoadingMessage(`Establishing connection to ${mfg.name} database...`);
    const catalogData = await storage.getManufacturerCatalog(mfg.id);
    mfg.catalog = catalogData;
    setLoadingMessage(`Fetching ${mfg.tiers.length} pricing tiers...`);
    await new Promise(r => setTimeout(r, 500));
    const defaultSeries = mfg.series && mfg.series.length > 0 ? mfg.series[0].name : '';
    const defaultSpecs: any = {
        ...project?.specs,
        manufacturer: mfg.name,
        priceGroup: mfg.tiers[0]?.name || 'Standard',
        seriesName: defaultSeries,
        lineType: 'Midland', // Default preference
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
             const pricing = calculateProjectPricing(project.items, mfg, tierIdToUse, project.specs);
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
     updateProject({ specs: newSpecs });
  };

  const toggleOption = (optionId: string, checked: boolean) => {
      if (!project || !project.specs) return;
      const newSelected = { ...project.specs.selectedOptions, [optionId]: checked };
      updateProject({ specs: { ...project.specs, selectedOptions: newSelected } });
  };


  if (!project) return null;
  const currentMfg = manufacturers.find(m => m.id === project.manufacturerId);
  const groupedReviewItems = getGroupedItems(project.items);

  // Group options for display
  const groupedOptions: Record<string, ManufacturerOption[]> = {
      'Construction': [], 'Drawer': [], 'Hardware': [], 'Paint': [], 'Door': [], 'DoorStyle': [], 'Finish': [], 'PrintedEnd': [], 'Series': [], 'Wood': [], 'Other': [],
      'Door Edge': [], 'Glaze': [], 'Highlight': [], 'Door Option': []
  };
  
  if (currentMfg && currentMfg.options) {
      currentMfg.options.forEach(opt => {
          let cat: string = opt.category;
          if (cat === 'Hinge') cat = 'Hardware';
          if (cat === 'Highlights') cat = 'Highlight';
          if (cat === 'DoorOption') cat = 'Door Option';
          if (cat === 'DoorEdge') cat = 'Door Edge';

          if (!groupedOptions[cat]) cat = 'Other';
          groupedOptions[cat].push(opt);

          // Heuristic: Also populate 'Wood' if name contains common species
          // This allows "Material" dropdown to be dynamic even if category isn't explicitly 'Wood'
          if (['Maple', 'Oak', 'Cherry', 'Alder', 'Walnut', 'Hickory', 'Birch', 'Poplar', 'MDF', 'Paint Grade', 'Rustic'].some(w => opt.name.includes(w))) {
              if (!groupedOptions['Wood'].find(x => x.name === opt.name)) {
                  groupedOptions['Wood'].push(opt);
              }
          }
      });
  }
  if (currentMfg?.series?.length > 0) {
      currentMfg.series.forEach(s => {
          if (!groupedOptions['Series'].find(d => d.name === s.name)) {
              groupedOptions['Series'].push({
                  id: `series_${s.id}`, name: s.name, category: 'Series', section: 'B-Series', pricingType: 'included', price: 0
              });
          }
          // Also keep backward compatibility for DoorStyle lookup if needed, but primarily Series
          if (!groupedOptions['DoorStyle'].find(d => d.name === s.name)) {
             groupedOptions['DoorStyle'].push({
                 id: `series_${s.id}_ds`, name: s.name, category: 'DoorStyle', section: 'B-Series', pricingType: 'included', price: 0
             });
          }
      });
  }
  if (currentMfg?.tiers?.length > 0) {
      currentMfg.tiers.forEach(t => {
          if (t.name.includes(' - ')) {
              const possibleStyle = t.name.split(' - ')[0];
              if (!['Standard', 'Premium', 'Level', 'Group', 'Tier'].some(w => possibleStyle.includes(w))) {
                   if (!groupedOptions['DoorStyle'].find(d => d.name === possibleStyle)) {
                        groupedOptions['DoorStyle'].push({
                            id: `tier_derived_${possibleStyle}`, name: possibleStyle, category: 'DoorStyle', section: 'Unknown', pricingType: 'included', price: 0
                        });
                   }
              }
          }
          // Also try to extract Wood Species from Tier Names (e.g. "Oak Standard")
          const commonWoods = ['Maple', 'Oak', 'Cherry', 'Alder', 'Walnut', 'Hickory', 'Birch', 'Poplar', 'MDF'];
          commonWoods.forEach(wood => {
              if (t.name.includes(wood)) {
                  if (!groupedOptions['Wood'].find(w => w.name === wood)) {
                      groupedOptions['Wood'].push({
                          id: `tier_wood_${wood}`, name: wood, category: 'Other', section: 'Unknown', pricingType: 'included', price: 0
                      });
                  }
              }
          });
      });
  }
  const availableFinishes = [...groupedOptions['Finish'], ...groupedOptions['PrintedEnd'], ...groupedOptions['Paint']].sort((a,b) => a.name.localeCompare(b.name));
  const checklistOptions = [...groupedOptions['Construction'], ...groupedOptions['Drawer'], ...groupedOptions['Hardware'], ...groupedOptions['Finish'], ...groupedOptions['Paint'], ...groupedOptions['PrintedEnd'], ...groupedOptions['Door'], ...groupedOptions['Other']];
  
  // Dynamic Options Lists
  const seriesOptions = groupedOptions['Series'].length > 0 ? groupedOptions['Series'].map(o => o.name) : ["Midland", "Heartland", "Classic", "All"];
  const drawerOptions = groupedOptions['Drawer'].length > 0 ? groupedOptions['Drawer'].map(o => o.name) : ["Standard Epoxy", "Dovetail Plywood", "Metal Box", "BLUMSC-7/8"];
  const hingeOptions = groupedOptions['Hardware'].length > 0 ? groupedOptions['Hardware'].map(o => o.name) : ["Standard", "Soft Close", "Full", "Exposed"];
  const woodOptions = groupedOptions['Wood'].length > 0 ? groupedOptions['Wood'].map(o => o.name) : ["Maple", "Oak", "Cherry", "Paint Grade-HD", "HDF"];
  
  const doorOptionOptions = groupedOptions['Door Option'].length > 0 ? groupedOptions['Door Option'].map(o => o.name) : [];
  const doorEdgeOptions = groupedOptions['Door Edge'].length > 0 ? groupedOptions['Door Edge'].map(o => o.name) : [];
  const glazeOptions = groupedOptions['Glaze'].length > 0 ? groupedOptions['Glaze'].map(o => o.name) : [];
  const highlightOptions = groupedOptions['Highlight'].length > 0 ? groupedOptions['Highlight'].map(o => o.name) : [];
  
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
                 <div className="border-2 border-dashed border-slate-300 rounded-xl p-12 w-full max-w-lg hover:border-brand-500 hover:bg-brand-50 transition-all cursor-pointer relative" onClick={() => document.getElementById('plan-upload')?.click()}>
                    <p className="font-medium text-slate-700">Click to Browse</p>
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
                         <thead className="bg-slate-100"><tr><th className="px-6 py-3 text-left text-xs font-bold text-slate-500 uppercase">Item Description</th><th className="px-6 py-3 text-left text-xs font-bold text-slate-500 uppercase">PDF Code (Editable)</th><th className="px-6 py-3 text-left text-xs font-bold text-brand-600 uppercase">Normalized</th><th className="px-6 py-3 text-center text-xs font-bold text-slate-500 uppercase">Qty (Editable)</th><th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase">Action</th></tr></thead>
                         <tbody className="divide-y divide-slate-100 bg-white">
                            {groupedReviewItems.map(group => (<React.Fragment key={group.type}><tr className="bg-slate-50"><td colSpan={5} className="px-6 py-2 font-bold text-xs text-slate-600 uppercase tracking-wider">{group.type} Cabinets</td></tr>{group.items.map(item => (<tr key={item.id} className="hover:bg-blue-50 group"><td className="px-6 py-3 text-sm text-slate-900">{item.description}<div className="text-xs text-slate-400 mt-0.5">{item.width > 0 && `${item.width}" W x `}{item.height}" H x {item.depth}" D</div>{item.modifications && item.modifications.length > 0 && (<div className="mt-1 pl-2 border-l-2 border-slate-200 text-xs text-slate-500">{item.modifications.map((m, i) => (<div key={i}>+ {m.description}</div>))}</div>)}</td><td className="px-6 py-3 text-sm text-slate-500 font-mono"><DebouncedInput className="w-full bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5 font-bold text-slate-800" value={item.originalCode} onChange={(val: string) => updateProjectItem(item.id, { originalCode: val.toUpperCase() })}/></td><td className="px-6 py-3 text-sm text-brand-700 font-bold font-mono">{item.normalizedCode || item.originalCode}</td><td className="px-6 py-3 text-center font-medium"><DebouncedInput type="number" className="w-16 text-center bg-transparent border-b border-dashed border-slate-300 focus:border-brand-500 focus:outline-none focus:bg-white px-1 py-0.5" value={item.quantity} onChange={(val: number) => updateProjectItem(item.id, { quantity: val || 0 })}/></td><td className="px-4 py-3 text-right"><button type="button" onClick={() => deleteProjectItem(item.id)} className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors" title="Remove Item"><Trash2 className="w-4 h-4"/></button></td></tr>))}</React.Fragment>))}
                         </tbody>
                    </table>
                </div>
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
                <div className="border border-slate-300 rounded-lg overflow-hidden shadow-sm">
                    <div className="bg-slate-100 px-6 py-3 border-b border-slate-300"><h3 className="font-bold text-slate-800 flex items-center gap-2"><Grid3X3 className="w-4 h-4"/> Kitchen: {project.name || 'Area Name'}</h3></div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6 p-6 bg-white">
                        <SpecField label="Cabinet Line" type="select" options={seriesOptions} value={project.specs?.lineType} onChange={(v: string) => updateSpec('lineType', v)} />
                        <SpecField label="Cardboard Boxed Cabinets" type="select" options={["Yes", "No"]} value={project.specs?.cardboardBoxed} onChange={(v: string) => updateSpec('cardboardBoxed', v)} />
                        <div className="flex flex-col"><label className="text-[10px] uppercase font-bold text-slate-500 mb-1">Wall / Base Door Style</label><div className="flex gap-2"><select className="w-1/2 p-2 border border-slate-300 rounded text-sm bg-white" value={project.specs?.wallDoorStyle || ''} onChange={(e) => updateSpec('wallDoorStyle', e.target.value)}><option value="">Select Style...</option>{groupedOptions['DoorStyle'].filter(opt => !/^\d+$/.test(opt.name.trim()) && opt.name.trim().length > 1).sort((a,b) => a.name.localeCompare(b.name)).map(opt => <option key={opt.id} value={opt.name}>{opt.name}</option>)}</select><DebouncedInput className="w-1/2 p-2 border border-slate-300 rounded text-sm" placeholder="Base Style" value={project.specs?.baseDoorStyle || project.specs?.wallDoorStyle || ''} onChange={(val: string) => updateSpec('baseDoorStyle', val)} /></div></div>
                        <SpecField label="Wall Door Option" type={doorOptionOptions.length > 0 ? "select" : "text"} options={doorOptionOptions} value={project.specs?.wallDoorOption} onChange={(v: string) => updateSpec('wallDoorOption', v)} />
                        <SpecField label="Base Door Option" type={doorOptionOptions.length > 0 ? "select" : "text"} options={doorOptionOptions} value={project.specs?.baseDoorOption} onChange={(v: string) => updateSpec('baseDoorOption', v)} />
                        <SpecField label="Door Edge" type={doorEdgeOptions.length > 0 ? "select" : "text"} options={doorEdgeOptions} value={project.specs?.doorEdge} onChange={(v: string) => updateSpec('doorEdge', v)} />
                        <SpecField label="Drawer Box" type="select" options={drawerOptions} value={project.specs?.drawerBox} onChange={(v: string) => updateSpec('drawerBox', v)} />
                        <SpecField label="Drawer Front" value={project.specs?.drawerFront} onChange={(v: string) => updateSpec('drawerFront', v)} />
                        <SpecField label="Hinge" type="select" options={hingeOptions} value={project.specs?.hingeType} onChange={(v: string) => updateSpec('hingeType', v)} />
                        <SpecField label="Soft Close Hinges" type="select" options={["Yes", "No"]} value={project.specs?.softCloseHinges} onChange={(v: string) => updateSpec('softCloseHinges', v)} />
                        <SpecField label="Wood" type="select" options={woodOptions} value={project.specs?.woodSpecies} onChange={(v: string) => updateSpec('woodSpecies', v)} />
                        <div className="flex flex-col"><label className="text-[10px] uppercase font-bold text-slate-500 mb-1">Cabinet Finish / Color</label><select className="w-full p-2 border border-slate-300 rounded text-sm bg-white" value={project.specs?.finishColor || ''} onChange={(e) => updateSpec('finishColor', e.target.value)}><option value="">Select Finish...</option>{availableFinishes.some(o => o.name.startsWith('Stain:')) && (<optgroup label="Stain">{availableFinishes.filter(o => o.name.startsWith('Stain:')).map(opt => <option key={opt.id} value={opt.name.replace('Stain: ', '')}>{opt.name.replace('Stain: ', '')}</option>)}</optgroup>)}{availableFinishes.some(o => o.name.startsWith('Paint:')) && (<optgroup label="Paint">{availableFinishes.filter(o => o.name.startsWith('Paint:')).map(opt => <option key={opt.id} value={opt.name.replace('Paint: ', '')}>{opt.name.replace('Paint: ', '')}</option>)}</optgroup>)}{availableFinishes.some(o => !o.name.startsWith('Paint:') && !o.name.startsWith('Stain:')) && (<optgroup label="Other Options">{availableFinishes.filter(o => !o.name.startsWith('Paint:') && !o.name.startsWith('Stain:')).map(opt => <option key={opt.id} value={opt.name}>{opt.name}</option>)}</optgroup>)}</select></div>
                        <SpecField label="Glaze" type={glazeOptions.length > 0 ? "select" : "text"} options={glazeOptions} value={project.specs?.glaze} onChange={(v: string) => updateSpec('glaze', v)} />
                        <SpecField label="Finish Option 1" value={project.specs?.finishOption1} onChange={(v: string) => updateSpec('finishOption1', v)} />
                        <SpecField label="Finish Option 2" value={project.specs?.finishOption2} onChange={(v: string) => updateSpec('finishOption2', v)} />
                        <div className="flex flex-col"><label className="text-[10px] uppercase font-bold text-slate-500 mb-1">Printed Ends</label><select className="w-full p-2 border border-slate-300 rounded text-sm bg-white" value={project.specs?.printedEndOption || 'No'} onChange={(e) => updateSpec('printedEndOption', e.target.value)}><option value="No">No</option><option value="Matching">Matching</option>{availableFinishes.some(o => o.name.startsWith('Stain:')) && (<optgroup label="Stain">{availableFinishes.filter(o => o.name.startsWith('Stain:')).map(opt => <option key={opt.id} value={opt.name.replace('Stain: ', '')}>{opt.name.replace('Stain: ', '')}</option>)}</optgroup>)}{availableFinishes.some(o => o.name.startsWith('Paint:')) && (<optgroup label="Paint">{availableFinishes.filter(o => o.name.startsWith('Paint:')).map(opt => <option key={opt.id} value={opt.name.replace('Paint: ', '')}>{opt.name.replace('Paint: ', '')}</option>)}</optgroup>)}</select></div>
                        <SpecField label="Highlights" type={highlightOptions.length > 0 ? "select" : "text"} options={highlightOptions} value={project.specs?.highlights} onChange={(v: string) => updateSpec('highlights', v)} />
                    </div>
                </div>
                {checklistOptions.length > 0 && (<div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm mt-6"><h4 className="font-bold text-slate-800 mb-4 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-brand-600"/> Additional Upgrades & Options</h4><div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{checklistOptions.map(opt => (<label key={opt.id} className="flex items-start gap-3 p-3 hover:bg-slate-50 rounded cursor-pointer border border-slate-100 hover:border-brand-200 transition-all"><input type="checkbox" className="mt-1 w-4 h-4 text-brand-600 rounded border-gray-300 focus:ring-brand-500" checked={!!project.specs?.selectedOptions?.[opt.id]} onChange={(e) => toggleOption(opt.id, e.target.checked)}/><div className="text-sm"><div className="font-medium text-slate-900">{opt.name}</div><div className="text-slate-500 text-xs flex justify-between gap-4 mt-1"><span>{opt.category}</span><span className="font-mono text-brand-700 font-bold">{opt.pricingType === 'percentage' ? `+${(opt.price*100).toFixed(0)}%` : `+$${opt.price}`}</span></div></div></label>))}</div></div>)}
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
                    <div className="flex-1 overflow-x-auto border border-slate-200 rounded-lg shadow-sm">
                        <table className="min-w-full divide-y divide-slate-200">
                            <thead className="bg-slate-800 text-white"><tr><th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider">#</th><th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider">Cab Code</th><th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider">Description / Dims</th><th className="px-4 py-3 text-center text-xs font-bold uppercase tracking-wider">Qty</th><th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider">Unit Price</th><th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider">Total</th></tr></thead>
                            <tbody className="bg-white divide-y divide-slate-100">
                                {project.pricing.map((item, index) => (
                                    <tr key={item.id} className={`hover:bg-slate-50 ${item.totalPrice === 0 ? 'bg-red-50/30' : ''}`}>
                                        <td className="px-4 py-3 text-slate-400 text-sm">{index + 1}</td>
                                        <td className="px-4 py-3 font-mono font-bold text-slate-800 text-sm">{item.normalizedCode}{item.originalCode !== item.normalizedCode && (<div className="text-xs text-slate-400 font-normal">ref: {item.originalCode}</div>)}<div className="text-[10px] text-slate-400 mt-1">{item.source}</div></td>
                                        <td className="px-4 py-3 text-sm text-slate-700"><div className="font-medium">{item.description}</div><div className="text-xs text-slate-500 mt-0.5">{item.width}"W x {item.height}"H x {item.depth}"D</div>{item.appliedOptions && item.appliedOptions.length > 0 && (<div className="mt-1 flex flex-wrap gap-1">{item.appliedOptions.map((opt, i) => (<span key={i} className="text-[10px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded border border-green-100">+{opt.name} (${opt.price})</span>))}</div>)}</td>
                                        <td className="px-4 py-3 text-center text-sm font-medium">{item.quantity}</td>
                                        <td className="px-4 py-3 text-right text-sm">{item.finalUnitPrice === 0 ? (<span className="flex items-center justify-end gap-1 text-red-600 font-bold bg-red-50 px-2 py-0.5 rounded"><AlertCircle className="w-3 h-3"/> CHECK PRICE</span>) : (<span className="text-slate-600">${item.finalUnitPrice.toLocaleString()}</span>)}</td>
                                        <td className="px-4 py-3 text-right text-sm font-bold">{item.totalPrice === 0 ? (<span className="text-red-600">$0.00</span>) : (<span className="text-slate-900">${item.totalPrice.toLocaleString()}</span>)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    
                    <div className="w-full lg:w-80 shrink-0 space-y-4">
                        <div className="bg-slate-50 p-5 rounded-xl border border-slate-200">
                             <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4"><Calculator className="w-4 h-4"/> Quote Financials</h3>
                             <div className="space-y-4">
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Dealer Discount (%)</label><div className="relative mt-1"><DebouncedInput type="number" min="0" max="100" className="w-full pl-3 pr-8 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.discountRate} onChange={(val: number) => updateFinancials('discountRate', val || 0)} /><span className="absolute right-3 top-2 text-slate-400 text-sm">%</span></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Sales Tax Rate (%)</label><div className="relative mt-1"><DebouncedInput type="number" min="0" max="100" step="0.1" className="w-full pl-3 pr-8 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.taxRate} onChange={(val: number) => updateFinancials('taxRate', val || 0)} /><span className="absolute right-3 top-2 text-slate-400 text-sm">%</span></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Shipping Cost ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.shippingCost} onChange={(val: number) => updateFinancials('shippingCost', val || 0)} /></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Fuel Surcharge ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.fuelSurcharge} onChange={(val: number) => updateFinancials('fuelSurcharge', val || 0)} /></div></div>
                                 <div><label className="text-xs font-bold text-slate-500 uppercase">Misc Charges ($)</label><div className="relative mt-1"><span className="absolute left-3 top-2 text-slate-400 text-sm">$</span><DebouncedInput type="number" min="0" className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-brand-500" value={financials.miscCharge} onChange={(val: number) => updateFinancials('miscCharge', val || 0)} /></div></div>
                                 
                                 <div className="pt-4 border-t border-slate-200 mt-4">
                                     {(() => {
                                         const subTotal = project.pricing.reduce((acc, i) => acc + i.totalPrice, 0);
                                         const discountAmount = subTotal * (financials.discountRate / 100);
                                         const postDiscount = subTotal - discountAmount;
                                         const taxAmount = postDiscount * (financials.taxRate / 100);
                                         const grandTotal = postDiscount + financials.shippingCost + financials.fuelSurcharge + financials.miscCharge + taxAmount;
                                         
                                         return (
                                             <>
                                                 <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Subtotal:</span><span className="font-medium">${subTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Discount ({financials.discountRate}%):</span><span className="font-medium text-red-600">- ${discountAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Net:</span><span className="font-medium">${postDiscount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 {financials.taxRate > 0 && <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Tax ({financials.taxRate}%):</span><span className="font-medium">${taxAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>}
                                                 {(financials.shippingCost > 0 || financials.fuelSurcharge > 0 || financials.miscCharge > 0) && (
                                                     <div className="flex justify-between text-sm mb-2"><span className="text-slate-500">Fees:</span><span className="font-medium">${(financials.shippingCost + financials.fuelSurcharge + financials.miscCharge).toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
                                                 )}
                                                 <div className="flex justify-between text-base font-bold text-slate-900 mt-3 pt-3 border-t border-slate-200"><span>Est. Grand Total:</span><span>${grandTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>
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
                     <Button size="lg" onClick={handleDownloadPDF} className="w-full shadow-xl shadow-brand-500/20 py-6 text-lg h-auto flex-col gap-1">
                        <div className="flex items-center gap-2"><DownloadCloud className="w-6 h-6" /> Download PDF</div>
                        <span className="text-xs font-normal opacity-90">Official Quote Format</span>
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