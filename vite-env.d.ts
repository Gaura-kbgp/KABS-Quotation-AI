// Define process.env for client-side usage (e.g. process.env.API_KEY)
// We declare global augmentations to ensure types are correct without conflicting with @types/node

export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      [key: string]: string | undefined;
      API_KEY?: string;
      SUPABASE_URL?: string;
      SUPABASE_ANON_KEY?: string;
      SUPABASE_SERVICE_KEY?: string;
    }
  }
}
