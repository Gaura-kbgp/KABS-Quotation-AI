import React from 'react';
import { ArrowLeft, Construction, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';

export const DrawingAI: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-8 animate-in fade-in duration-500 p-4">
      <div className="relative">
         <div className="w-32 h-32 bg-brand-50 rounded-full flex items-center justify-center text-brand-600 mb-4 animate-pulse">
            <Construction className="w-16 h-16" />
         </div>
         <div className="absolute -top-2 -right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-3 py-1 rounded-full shadow-sm animate-bounce">
            Under Construction
         </div>
      </div>
      
      <div className="space-y-4 max-w-lg">
          <h1 className="text-4xl font-extrabold text-slate-900">Drawing AI Generation</h1>
          <p className="text-lg text-slate-500">
            We are training advanced models to automatically generate 2D & 3D kitchen layouts from simple text descriptions and room dimensions.
          </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-2xl mt-8">
          <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 font-bold text-slate-800 mb-2">
                 <Sparkles className="w-4 h-4 text-purple-500"/> Generative Layouts
              </div>
              <p className="text-xs text-slate-500">AI-optimized cabinet placement for maximum efficiency.</p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 font-bold text-slate-800 mb-2">
                 <Sparkles className="w-4 h-4 text-blue-500"/> Instant Elevations
              </div>
              <p className="text-xs text-slate-500">Auto-generated wall elevations for installers.</p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 font-bold text-slate-800 mb-2">
                 <Sparkles className="w-4 h-4 text-green-500"/> Photorealistic Renders
              </div>
              <p className="text-xs text-slate-500">High-quality visualization of finishes and materials.</p>
          </div>
      </div>

      <div className="mt-12">
        <Button variant="ghost" onClick={() => navigate('/')} className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Return to Home
        </Button>
      </div>
    </div>
  );
};