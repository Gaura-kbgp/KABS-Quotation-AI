
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
    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const numPages = pdf.numPages;
        const textPages: string[] = [];

        // Process in chunks to avoid UI freezing
        // Text extraction is fast, so larger chunks (25) are safe and reduce overhead
        const CHUNK_SIZE = 25; 
        for (let i = 1; i <= numPages; i += CHUNK_SIZE) {
            const chunkPromises = [];
            const end = Math.min(i + CHUNK_SIZE - 1, numPages);
            
            for (let j = i; j <= end; j++) {
                chunkPromises.push(pdf.getPage(j).then(async (page) => {
                    const textContent = await page.getTextContent();
                    const text = textContent.items.map((item: any) => item.str).join('\n');
                    // Add delimiter for page splitting in AI service
                    return `--- PAGE ${j} ---\n${text}\n`;
                }));
            }
            
            const results = await Promise.all(chunkPromises);
            // Promise.all preserves order, so we can just push results
            textPages.push(...results);
            
            // Minimal delay for text extraction
            if (i + CHUNK_SIZE <= numPages) await new Promise(resolve => setTimeout(resolve, 5));
        }

        return textPages.join('\n');
    } catch (error) {
        console.error("Error extracting text from PDF:", error);
        throw new Error("Failed to extract text from PDF");
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
        // INCREASED CHUNK SIZE for 100-page speed optimization (10 pages per batch)
        const CHUNK_SIZE = 10; 
        const results: (PDFPageImage | null)[] = [];

        for (let i = 0; i < pageNumbers.length; i += CHUNK_SIZE) {
            const chunk = pageNumbers.slice(i, i + CHUNK_SIZE);
            console.log(`Processing image chunk: pages ${chunk.join(', ')}`);
            
            const chunkPromises = chunk.map(async (pageNum) => {
                try {
                    const page = await pdf.getPage(pageNum);
                    
                    const viewport = page.getViewport({ scale: 1.5 }); // Lower scale = lower resolution/size
                    
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    
                    if (!context) throw new Error("Canvas context not available");

                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    await page.render({
                        canvasContext: context,
                        viewport: viewport
                    } as any).promise;

                    // Convert to JPEG with quality 0.5 (Fast Web Quality)
                    // Reduced from 0.6 to 0.5 to speed up processing and reduce payload size
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
                    
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
            
            // Reduced delay to 2ms (was 5ms) to speed up batch processing
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        
        // Filter out any failed pages (nulls) and sort by page number to be safe
        const images = results.filter((img): img is PDFPageImage => img !== null).sort((a, b) => a.pageNumber - b.pageNumber);
        
        return images;
    } catch (err) {
        console.error("Error processing PDF:", err);
        throw new Error("Failed to process PDF pages. Please check if the file is valid.");
    }
}
