# KABS Quotation & Design System

A next-generation automated quotation system for the cabinetry industry, powered by **Gemini 2.5 AI** and **Supabase**. This application processes architectural drawings (PDF/Images), extracts cabinet specifications using computer vision/OCR, and automatically generates priced quotations by matching against manufacturer catalogs.

## 🚀 Tech Stack

### Frontend
- **Framework**: [React](https://react.dev/) (v18)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Routing**: React Router DOM
- **UI/Icons**: Lucide React
- **PDF Generation**: jsPDF & jsPDF-AutoTable
- **Excel Processing**: SheetJS (xlsx)

### Backend & Services
- **Database & Auth**: [Supabase](https://supabase.com/)
- **AI Engine**: [Google Gemini 2.5 Pro/Flash](https://deepmind.google/technologies/gemini/) (via `@google/genai`)
- **State Management**: React Context / Local State

## 📂 Codebase Structure

### Core Services (`/services`)
- **`ai.ts`**: The brain of the operation. Contains the `analyzePlan` function which sends PDFs/Images to Gemini 2.5 with a specialized system prompt for high-recall extraction of cabinet codes. Includes resilient JSON parsing logic.
- **`pricingEngine.ts`**: Contains the "Smartbrain" logic (`generateSmartKeys`, `normalizeNKBACode`) that matches extracted OCR codes (e.g., "VDB27AH-3") to standardized NKBA catalog codes (e.g., "VDB27"). Handles fuzzy matching, neighbor searching, and pricing calculations.
- **`storage.ts`**: Interacts with Supabase for saving projects, retrieving manufacturer catalogs, and managing user sessions.
- **`supabase.ts`**: Supabase client configuration.

### Views (`/views`)
- **`QuotationFlow.tsx`**: The main wizard-style interface for users. Handles the flow: Upload -> AI Extraction -> Verification -> Pricing -> PDF Export.
- **`Admin.tsx`**: Back-office interface for uploading manufacturer Excel catalogs and managing global settings.
- **`DrawingAI.tsx`**: Specialized view for visual drawing analysis (experimental).
- **`Home.tsx`**: Dashboard for viewing active projects.

### Components (`/components`)
- **`Button.tsx`**: Reusable UI button component.
- **`Layout.tsx`**: Main application wrapper with navigation.

## 🔑 Key Features

1.  **AI Extraction**: Upload a floor plan or cabinet list (PDF/Image). The system uses Gemini 2.5 Vision to identify every cabinet code, dimension, and modification.
2.  **Smart Pricing Engine**: Automatically maps extracted codes to manufacturer catalogs, handling typos, formatting differences (e.g., "B15" vs "B-15"), and alternative sizing (nearest neighbor search).
3.  **Dynamic Catalogs**: Administrators can upload raw Excel price lists. The system automatically detects SKU and Price columns.
4.  **PDF Generation**: Generates professional quote PDFs with dealer branding, totals, and detailed line items.

## 🛠️ Setup Guide for Developers

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/Gaura-kbgp/KABS-Quotation-AI.git
    cd KABS-Quotation-AI
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Environment Variables**:
    Create a `.env` file in the root directory:
    ```env
    VITE_SUPABASE_URL=your_supabase_url
    VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
    VITE_GEMINI_API_KEY=your_gemini_api_key
    ```

4.  **Run Development Server**:
    ```bash
    npm run dev
    ```

## 📖 User Guide

### Creating a Quote
1.  **Start New Project**: Click "New Project" on the dashboard.
2.  **Upload Plans**: Drag & Drop your architectural PDF or images.
3.  **AI Analysis**: Wait for the AI to scan the document (approx. 10-30 seconds).
4.  **Review Items**: The system will present a list of extracted cabinets.
    - **Green Items**: Exact match found in catalog.
    - **Yellow/Red Items**: Check these. You may need to manually select the correct SKU if the AI read it poorly.
5.  **Configure Specs**: Select Door Style, Finish, and Construction options.
6.  **Export**: Click "Generate Quote" to download the PDF.

### Admin: Adding Catalogs
1.  Go to the **Admin** tab.
2.  Create a new Manufacturer (e.g., "Koch Classic").
3.  Upload an Excel file (.xlsx) containing SKUs and Prices.
4.  The AI will auto-detect the column structure. Confirm and Save.
