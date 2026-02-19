import React, { Suspense, lazy } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loader2 } from 'lucide-react';

// Lazy Load Pages for Performance Optimization
const Home = lazy(() => import('./views/Home').then(module => ({ default: module.Home })));
const Admin = lazy(() => import('./views/Admin').then(module => ({ default: module.Admin })));
const Login = lazy(() => import('./views/Login').then(module => ({ default: module.Login })));
const QuotationFlow = lazy(() => import('./views/QuotationFlow').then(module => ({ default: module.QuotationFlow })));
const DesignAI = lazy(() => import('./views/DesignAI').then(module => ({ default: module.DesignAI })));

const LoadingSpinner = () => (
  <div className="flex h-screen w-full items-center justify-center">
    <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
  </div>
);

const App: React.FC = () => {
  return (
    <HashRouter>
      <Layout>
        <Suspense fallback={<LoadingSpinner />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/quote" element={<QuotationFlow />} />
            <Route path="/design-ai" element={<DesignAI />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </HashRouter>
  );
};

export default App;