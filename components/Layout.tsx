import React from 'react';
import { Home, Settings, ShieldCheck, LogOut } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const isAdminPath = location.pathname.startsWith('/admin');
  const isAdminLoggedIn = !!sessionStorage.getItem('kabs_is_admin');

  const handleLogout = () => {
    sessionStorage.removeItem('kabs_is_admin');
    navigate('/');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold">
              K
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">KABS</span>
          </Link>
          
          <nav className="flex items-center gap-6">
            {!isAdminLoggedIn && !isAdminPath && (
              <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-brand-600 transition-colors">
                Admin Access
              </Link>
            )}
            {isAdminLoggedIn && (
               <button 
                 onClick={handleLogout}
                 className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-red-600 transition-colors"
               >
                 <LogOut className="w-4 h-4" />
                 Exit Admin
               </button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8">
        {children}
      </main>

      <footer className="bg-white border-t border-slate-200 py-6 mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center text-slate-400 text-sm">
          &copy; {new Date().getFullYear()} KABS Inc. Production Build v1.0.4
        </div>
      </footer>
    </div>
  );
};
