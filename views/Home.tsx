import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, PenTool, ArrowRight } from 'lucide-react';
import { Button } from '../components/Button';
import { storage } from '../services/storage';

export const Home: React.FC = () => {
  const navigate = useNavigate();

  const handleStartQuote = async () => {
    // Initialize new project
    await storage.saveActiveProject({
      id: crypto.randomUUID(),
      name: 'New Kitchen Quote',
      clientName: 'Unknown Client',
      dateCreated: new Date().toISOString(),
      status: 'Draft',
      items: []
    });
    navigate('/quote');
  };

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-5xl font-extrabold text-slate-900 tracking-tight">
          Professional Cabinet Quotation
          <span className="block text-brand-600">Automated by AI.</span>
        </h1>
        <p className="text-xl text-slate-500">
          KABS transforms PDF drawings into manufacturer-ready quotes in seconds. 
          Zero manual entry. 100% compliant.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
        <Button 
          size="lg" 
          className="flex-1 gap-2 shadow-xl shadow-brand-500/20" 
          onClick={handleStartQuote}
        >
          <FileText className="w-5 h-5" />
          Quotation AI
          <ArrowRight className="w-4 h-4" />
        </Button>
        
        <Link to="/drawing-ai" className="flex-1">
          <Button variant="outline" size="lg" className="w-full gap-2">
            <PenTool className="w-5 h-5" />
            Drawing AI
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16 text-left max-w-4xl w-full">
        <div className="p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="w-10 h-10 bg-brand-100 text-brand-600 rounded-lg flex items-center justify-center mb-4 font-bold">1</div>
          <h3 className="font-bold text-slate-900 mb-2">Upload Drawing</h3>
          <p className="text-slate-500 text-sm">Drag and drop your kitchen PDF. Our AI analyzes layout, sizes, and specs instantly.</p>
        </div>
        <div className="p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="w-10 h-10 bg-brand-100 text-brand-600 rounded-lg flex items-center justify-center mb-4 font-bold">2</div>
          <h3 className="font-bold text-slate-900 mb-2">Auto-Normalization</h3>
          <p className="text-slate-500 text-sm">Items are automatically matched to NKBA standards and your chosen manufacturer's catalog.</p>
        </div>
        <div className="p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="w-10 h-10 bg-brand-100 text-brand-600 rounded-lg flex items-center justify-center mb-4 font-bold">3</div>
          <h3 className="font-bold text-slate-900 mb-2">Instant Pricing</h3>
          <p className="text-slate-500 text-sm">Real-time calculation based on uploaded Excel price sheets and selected quality tiers.</p>
        </div>
      </div>
    </div>
  );
};