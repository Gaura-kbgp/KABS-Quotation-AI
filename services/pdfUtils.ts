
// REMOVED top-level import to prevent large bundle size on initial load
// import * as pdfjsLib from 'pdfjs-dist';

// Singleton for the dynamically imported library
let pdfjsInstance: any = null;

async function getPdfJs() {
    if (pdfjsInstance) return pdfjsInstance;
    
    // Dynamic import
    const lib = await import('pdfjs-dist');
    
    // Configure worker
    lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    
    pdfjsInstance = lib;
    return lib;
}

export interface PDFPageImage {
    pageNumber: number;
    data: string; // Base64 (no prefix)
    mimeType: string;
}

export async function extractTextFromPdf(file: File): Promise<string> {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const numPages = pdf.numPages;
        console.log(`Extracting text from PDF (${numPages} pages)...`);

        let fullText = "";
        
        // Process pages in chunks to balance speed and memory
        // Parallelizing ALL pages at once might crash browser for large docs
        // So we batch them in groups of 5
        const CHUNK_SIZE = 5;
        const pageChunks = [];
        for (let i = 1; i <= numPages; i += CHUNK_SIZE) {
            const chunk = [];
            for (let j = 0; j < CHUNK_SIZE && i + j <= numPages; j++) {
                chunk.push(i + j);
            }
            pageChunks.push(chunk);
        }

        
        for (const chunk of pageChunks) {
            const chunkPromises = chunk.map(async (pageNum) => {
                try {
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();
                    // Preserve layout by joining with newline instead of space
                    const pageText = textContent.items
                        .map((item: any) => item.str)
                        .join('\n');
                    console.log(`Page ${pageNum} text length: ${pageText.length}`);
                    return { pageNum, text: pageText };
                } catch (pageErr) {
                    console.warn(`Failed to extract text from page ${pageNum}`, pageErr);
                    return { pageNum, text: "" };
                }
            });

            const results = await Promise.all(chunkPromises);
            // Sort by page number to maintain document order
            results.sort((a, b) => a.pageNum - b.pageNum);
            
            results.forEach(r => {
                 // Add extra newlines to ensure clean separation for regex splitting
                 fullText += `\n\n--- PAGE ${r.pageNum} ---\n\n${r.text}`;
            });
        }
        
        return fullText;
    } catch (err) {
        console.error("Text extraction failed:", err);
        return "";
    }
}

export async function convertPdfToImages(file: File): Promise<PDFPageImage[]> {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const numPages = pdf.numPages;

        console.log(`PDF loaded. Total pages: ${numPages}`);

        // Create an array of page numbers
        const pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1);

        // Process pages in parallel for speed
        // We use Promise.all to render all pages concurrently
        const renderPromises = pageNumbers.map(async (i) => {
            try {
                const page = await pdf.getPage(i);
                
                // Scale logic: Balanced quality for AI (1536px is optimal for multi-page token limits)
                // Target max dimension ~1536px (1.5K resolution) to allow 10+ pages in context
                let scale = 2.0;
                const unscaledViewport = page.getViewport({ scale: 1.0 });
                const maxDim = Math.max(unscaledViewport.width, unscaledViewport.height);
                
                // Limit to 1536px to prevent massive payloads with multi-page PDFs
                if (maxDim * scale > 1536) {
                    scale = 1536 / maxDim;
                }
                
                const viewport = page.getViewport({ scale });
                
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                
                if (!context) throw new Error("Canvas context not available");

                canvas.height = viewport.height;
                canvas.width = viewport.width;

                await page.render({
                    canvasContext: context,
                    viewport: viewport
                } as any).promise;

                // Convert to JPEG with balanced quality (0.7 for speed/size) 
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                
                // Strip prefix
                const cleanData = dataUrl.split(',')[1];
                
                console.log(`Rendered page ${i}/${numPages}`);

                return {
                    pageNumber: i,
                    data: cleanData,
                    mimeType: 'image/jpeg'
                } as PDFPageImage;

            } catch (pageError) {
                console.error(`Error rendering page ${i}:`, pageError);
                return null;
            }
        });

        const results = await Promise.all(renderPromises);
        
        // Filter out any failed pages (nulls) and sort by page number to be safe
        const images = results.filter((img): img is PDFPageImage => img !== null).sort((a, b) => a.pageNumber - b.pageNumber);
        
        return images;
    } catch (err) {
        console.error("Error processing PDF:", err);
        throw new Error("Failed to process PDF pages. Please check if the file is valid.");
    }
}
