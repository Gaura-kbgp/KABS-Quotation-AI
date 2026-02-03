import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './views/Home';
import { Admin } from './views/Admin';
import { Login } from './views/Login';
import { QuotationFlow } from './views/QuotationFlow';
import { DrawingAI } from './views/DrawingAI';

const App: React.FC = () => {
  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/quote" element={<QuotationFlow />} />
          <Route path="/drawing-ai" element={<DrawingAI />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
};

export default App;