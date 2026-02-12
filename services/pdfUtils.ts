
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

export async function convertPdfToImages(file: File, pagesToRender?: number[]): Promise<PDFPageImage[]> {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const numPages = pdf.numPages;

        console.log(`PDF loaded. Total pages: ${numPages}`);

        // Create an array of page numbers to render
        // If pagesToRender is provided, use it. Otherwise render all.
        let pageNumbers: number[];
        if (pagesToRender && pagesToRender.length > 0) {
            pageNumbers = pagesToRender.filter(p => p >= 1 && p <= numPages);
            console.log(`Rendering specific pages: ${pageNumbers.join(', ')}`);
        } else {
            pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1);
        }

        // Process pages in chunks to prevent UI freezing and browser crashes
        // Rendering high-res canvases is expensive.
        const CHUNK_SIZE = 3; 
        const results: (PDFPageImage | null)[] = [];

        for (let i = 0; i < pageNumbers.length; i += CHUNK_SIZE) {
            const chunk = pageNumbers.slice(i, i + CHUNK_SIZE);
            console.log(`Processing image chunk: pages ${chunk.join(', ')}`);
            
            const chunkPromises = chunk.map(async (pageNum) => {
                try {
                    const page = await pdf.getPage(pageNum);
                    
                    // Scale logic: Balanced quality for AI (2048px is standard for high-res LLM vision)
                    // Target max dimension ~2048px (2K resolution) to ensure speed while keeping labels readable
                    // Previous 3072px was too slow for client-side rendering
                    let scale = 3.0; 
                    const unscaledViewport = page.getViewport({ scale: 1.0 });
                    const maxDim = Math.max(unscaledViewport.width, unscaledViewport.height);
                    
                    // Limit to 2048px
                    if (maxDim * scale > 2048) {
                        scale = 2048 / maxDim;
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

                    // Convert to JPEG with quality 0.8 (slightly higher to compensate for lower res)
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    
                    // Strip prefix
                    const cleanData = dataUrl.split(',')[1];
                    
                    console.log(`Rendered page ${pageNum}/${numPages}`);

                    return {
                        pageNumber: pageNum,
                        data: cleanData,
                        mimeType: 'image/jpeg'
                    } as PDFPageImage;

                } catch (pageError) {
                    console.error(`Error rendering page ${pageNum}:`, pageError);
                    return null;
                }
            });

            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
            
            // Small delay to let the UI breathe
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Filter out any failed pages (nulls) and sort by page number to be safe
        const images = results.filter((img): img is PDFPageImage => img !== null).sort((a, b) => a.pageNumber - b.pageNumber);
        
        return images;
    } catch (err) {
        console.error("Error processing PDF:", err);
        throw new Error("Failed to process PDF pages. Please check if the file is valid.");
    }
}
