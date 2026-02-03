# Deployment Guide for KABS on Render.com

This application is a **React SPA** that uses **Vite** for production builds.

## Prerequisites

1.  A [Render](https://render.com) account.
2.  Your source code pushed to a GitHub or GitLab repository.

## Instructions

1.  **Create a New Static Site**
    *   Go to your Render Dashboard.
    *   Click **New +** and select **Static Site**.
    *   Connect your repository.

2.  **Configure Build Settings (CRITICAL)**
    *   **Name**: `kabs-app`
    *   **Branch**: `main`
    *   **Root Directory**: `.` (Leave default)
    *   **Build Command**: `npm install && npm run build`
        *   *Note: The included `.npmrc` file ensures dependencies install smoothly.*
    *   **Publish Directory**: `dist`
        *   *Note: Vite outputs the compiled production files to the `dist` folder.*

3.  **Configure Environment Variables**
    *   Scroll down to the **Environment Variables** section.
    *   Add the following keys:
    
    | Key | Value |
    | --- | --- |
    | `NODE_ENV` | `production` |
    | `API_KEY` | *(Your Google Gemini API Key)* |
    | `SUPABASE_URL` | *(Your Supabase Project URL)* |
    | `SUPABASE_ANON_KEY` | *(Your Supabase Anon Key)* |
    | `SUPABASE_SERVICE_KEY` | *(Your Supabase Service Role Key)* |

4.  **Deploy**
    *   Click **Create Static Site** (or **Manual Deploy** -> **Clear Build Cache & Deploy** if retrying).

## Troubleshooting

*   **White Screen / Blank Page**: Ensure **Publish Directory** is set to `dist`.
*   **Dependency Errors**: If `npm install` fails, ensure the `.npmrc` file is present in your repo root with `legacy-peer-deps=true`.
