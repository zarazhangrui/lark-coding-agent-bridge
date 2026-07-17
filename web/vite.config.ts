import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// Builds the management console into ONE self-contained index.html (JS+CSS+
// icons inlined) written to ../src/ui/generated/, which tsup then inlines into
// the CLI bundle as a string — the bridge serves it with zero runtime file/CDN
// deps (works offline).
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('../src/ui/generated', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
