import { Manufacturer, Project, NKBARules } from '../types';
import { supabase, supabaseAdmin } from './supabase';

const BUCKET_NAME = 'catalogs';

class StorageService {
  
  private bucketChecked = false;
  private catalogCache = new Map<string, any>();

  // --- Connection Check ---
  async checkConnection(): Promise<{ error: any }> {
      try {
          const { error } = await supabase.from('manufacturers').select('count', { count: 'exact', head: true });
          return { error };
      } catch (e) {
          return { error: e };
      }
  }

  // --- Manufacturers ---

  async getManufacturers(): Promise<Manufacturer[]> {
    // 1. Try Local Storage (Instant)
    const local = localStorage.getItem('kabs_local_manufacturers');
    if (local) {
        // Trigger background update
        this.fetchManufacturersFromCloud().catch(e => console.warn("Background mfg fetch failed", e));
        return JSON.parse(local);
    }

    // 2. If no local, must wait for cloud
    return await this.fetchManufacturersFromCloud();
  }

  private async fetchManufacturersFromCloud(): Promise<Manufacturer[]> {
    try {
      const { data, error } = await supabaseAdmin.from('manufacturers').select('*');
      if (!error && data) {
        const list = data.map((row: any) => row.data as Manufacturer);
        try { localStorage.setItem('kabs_local_manufacturers', JSON.stringify(list)); } catch(e) {}
        return list;
      }
    } catch (e) {
      console.error("Supabase fetch failed", e);
    }
    return [];
  }

  // New Method: Fetch heavy catalog only when needed
  async getManufacturerCatalog(mfgId: string): Promise<Record<string, Record<string, number>>> {
      // 1. Check Memory Cache
      if (this.catalogCache.has(mfgId)) {
          console.log(`[Storage] Serving catalog for ${mfgId} from memory cache.`);
          return this.catalogCache.get(mfgId);
      }

      try {
          console.log(`[Storage] Downloading catalog for ${mfgId} from Supabase...`);
          const { data, error } = await supabase.storage
            .from(BUCKET_NAME)
            .download(`${mfgId}.json`);
          
          if (error) {
              // 400 often means the file or bucket doesn't exist yet, which is expected for new items
              if (error.status !== 400 && error.status !== 404) {
                  console.warn("Catalog fetch error:", error);
              }
              return {};
          }
          
          const text = await data.text();
          const json = JSON.parse(text);
          
          // 2. Set Cache
          this.catalogCache.set(mfgId, json);
          
          return json;
      } catch (e) {
          console.error("Catalog download exception:", e);
          return {};
      }
  }

  // Clear cache if needed (e.g. on update/logout)
  clearCatalogCache(mfgId?: string) {
      if (mfgId) {
          this.catalogCache.delete(mfgId);
      } else {
          this.catalogCache.clear();
      }
  }

  // Optimization: Call this ONCE before batch operations
  async ensureBucket(): Promise<void> {
      if (this.bucketChecked) return;
      try {
          const { data: buckets } = await supabaseAdmin.storage.listBuckets();
          const bucketExists = buckets?.find(b => b.name === BUCKET_NAME);
          if (!bucketExists) {
              await supabaseAdmin.storage.createBucket(BUCKET_NAME, { public: true });
          }
          this.bucketChecked = true;
      } catch (e) {
          console.error("Bucket check failed", e);
      }
  }

  // Helper to upload an image found in Excel
  // Removed internal bucket check for performance in loops
  async uploadCatalogImage(mfgId: string, fileName: string, blob: Blob): Promise<string | null> {
      try {
          const path = `${mfgId}/images/${fileName}`;
          const { error } = await supabaseAdmin.storage
              .from(BUCKET_NAME)
              .upload(path, blob, { upsert: true, contentType: blob.type || 'image/png' });
          
          if (error) {
              console.error("Image upload error", error);
              return null;
          }

          const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
          return publicData.publicUrl;
      } catch (e) {
          console.error("Image upload exception", e);
          return null;
      }
  }

  // Upload a Spec Book PDF
  async uploadSpecBook(mfgId: string, file: File): Promise<string> {
      try {
          await this.ensureBucket();
          // Sanitize filename
          const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
          // Update: Organize by manufacturer ID (e.g., mfg_123/specs/myfile.pdf)
          const path = `${mfgId}/specs/${safeName}`;
          
          const { error } = await supabaseAdmin.storage
              .from(BUCKET_NAME)
              .upload(path, file, { 
                  upsert: true, 
                  contentType: 'application/pdf',
                  cacheControl: '3600'
              });
          
          if (error) {
              console.error("Spec upload error", error);
              throw new Error(error.message);
          }

          const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
          return publicData.publicUrl;
      } catch (e: any) {
          console.error("Spec upload exception", e);
          throw new Error(e.message || "Unknown upload error");
      }
  }

  // Saving: Split metadata (DB) and Catalog (Bucket)
  async saveManufacturer(mfg: Manufacturer, fullCatalog?: Record<string, any>): Promise<void> {
    const catalogToSave = fullCatalog || mfg.catalog || {};
    const skuCount = Object.keys(catalogToSave).length;
    
    // 1. Prepare Lightweight Object
    // Remove Base64 Data from files to prevent payload too large errors
    const slimFiles = (mfg.files || []).map(f => ({
        ...f,
        data: undefined // Ensure we don't send large strings to JSON column
    }));

    const slimMfg: Manufacturer = {
        ...mfg,
        catalog: undefined, // Don't store catalog in DB row
        files: slimFiles,
        skuCount: skuCount
    };
    
    // UPDATE CACHE: Immediately update local storage so UI is fast on reload/re-mount
    try {
        const currentStr = localStorage.getItem('kabs_local_manufacturers');
        let current = currentStr ? JSON.parse(currentStr) : [];
        current = [...current.filter((m:Manufacturer) => m.id !== mfg.id), slimMfg];
        localStorage.setItem('kabs_local_manufacturers', JSON.stringify(current));
    } catch (e) { console.warn("Cache update failed", e); }

    // 2. Upload Catalog to Storage Bucket (The "Separate Data" Store)
    if (skuCount > 0) {
        try {
            await this.ensureBucket(); // Ensure bucket exists before saving catalog

            // Upload JSON file
            const blob = new Blob([JSON.stringify(catalogToSave)], { type: 'application/json' });
            const { error: uploadError } = await supabaseAdmin.storage
                .from(BUCKET_NAME)
                .upload(`${mfg.id}.json`, blob, { upsert: true });

            if (uploadError) console.error("Bucket Upload Error:", uploadError);
            
            // CACHE UPDATE: Update memory cache directly
            this.catalogCache.set(mfg.id, catalogToSave);

        } catch (e) {
            console.error("Bucket Operation Failed:", e);
        }
    }

    // 3. Save Metadata to Table
    try {
        const { error } = await supabaseAdmin.from('manufacturers').upsert({
            id: mfg.id,
            data: slimMfg
        });
        if (error) {
            console.error("Supabase UPSERT Error Details:", JSON.stringify(error, null, 2));
            throw error;
        }
    } catch (e: any) {
        console.error("Supabase DB Save Exception:", e.message || e);
    }
  }
  
  // New method: Update just the DB row (metadata) to allow quick file deletions without re-uploading catalog
  async saveManufacturerMetadata(mfg: Manufacturer): Promise<void> {
    const slimFiles = (mfg.files || []).map(f => ({
        ...f,
        data: undefined
    }));

    const slimMfg: Manufacturer = {
        ...mfg,
        catalog: undefined,
        files: slimFiles,
        // Keep existing skuCount intact
    };

    // UPDATE CACHE: Immediate UI sync
    try {
        const currentStr = localStorage.getItem('kabs_local_manufacturers');
        let current = currentStr ? JSON.parse(currentStr) : [];
        current = [...current.filter((m:Manufacturer) => m.id !== mfg.id), slimMfg];
        localStorage.setItem('kabs_local_manufacturers', JSON.stringify(current));
    } catch (e) { console.warn("Cache update failed", e); }

    try {
        const { error } = await supabaseAdmin.from('manufacturers').upsert({
            id: mfg.id,
            data: slimMfg
        });
        if (error) throw error;
    } catch (e: any) {
        console.error("Metadata save failed", e);
        throw e;
    }
  }

  async deleteManufacturer(id: string): Promise<void> {
    // 1. Delete from Cloud
    try {
        await supabaseAdmin.storage.from(BUCKET_NAME).remove([`${id}.json`]);
        const { error } = await supabaseAdmin.from('manufacturers').delete().eq('id', id);
        if (error) console.error("DB Delete Error", error);
        
        // CACHE CLEAR
        this.clearCatalogCache(id);
    } catch(e) {
        console.warn("Supabase delete partial fail", e);
    }

    // 2. Delete from Local Storage (Critical for immediate UI sync/fallback)
    try {
        const local = localStorage.getItem('kabs_local_manufacturers');
        if (local) {
            const parsed = JSON.parse(local) as Manufacturer[];
            const updated = parsed.filter(m => m.id !== id);
            localStorage.setItem('kabs_local_manufacturers', JSON.stringify(updated));
        }
    } catch (e) {
        console.warn("Local storage delete fail", e);
    }
  }

  // --- Projects (Unchanged mostly, but robust) ---
  
  async getActiveProject(): Promise<Project | null> {
    const activeId = localStorage.getItem('kabs_active_project_id');
    if (!activeId) return null;

    // Try Local
    const localProjectsStr = localStorage.getItem('kabs_local_projects');
    if (localProjectsStr) {
        const projects = JSON.parse(localProjectsStr);
        const found = projects.find((p: Project) => p.id === activeId);
        if (found) return found;
    }
    return null; 
  }

  async saveActiveProject(project: Project): Promise<void> {
    localStorage.setItem('kabs_active_project_id', project.id);
    
    // Local Update
    const localProjectsStr = localStorage.getItem('kabs_local_projects');
    let projects: Project[] = localProjectsStr ? JSON.parse(localProjectsStr) : [];
    projects = [...projects.filter(p => p.id !== project.id), project];
    
    try {
        localStorage.setItem('kabs_local_projects', JSON.stringify(projects));
    } catch (e) {
        console.warn("Project local save failed (quota).");
    }

    // Cloud Sync (Best Effort)
    await supabase.from('projects').upsert({ id: project.id, data: project });
  }

  // --- NKBA Rules ---
  async getNKBARules(): Promise<NKBARules | null> {
    // 1. Try Local Cache First (Fastest)
    const local = localStorage.getItem('kabs_local_nkba_rules');
    if (local) {
        // Return immediately, then background refresh
        this.refreshNKBARules().catch(err => console.warn("Background NKBA refresh failed", err));
        return JSON.parse(local);
    }

    // 2. Fallback to Cloud if no cache
    return await this.fetchNKBARulesFromCloud();
  }

  private async fetchNKBARulesFromCloud(): Promise<NKBARules | null> {
    const { data } = await supabase.from('settings').select('*').eq('key', 'nkba_rules').single();
    if (data && data.value) {
         try { localStorage.setItem('kabs_local_nkba_rules', JSON.stringify(data.value)); } catch(e){}
         return data.value;
    }
    return null;
  }

  private async refreshNKBARules(): Promise<void> {
      await this.fetchNKBARulesFromCloud();
  }

  async saveNKBARules(rules: NKBARules): Promise<void> {
     // Cache update
     try { localStorage.setItem('kabs_local_nkba_rules', JSON.stringify(rules)); } catch (e) {}

     // Cloud Primary
     await supabaseAdmin.from('settings').upsert({ key: 'nkba_rules', value: rules });
  }
}

export const storage = new StorageService();