import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './', build:{rollupOptions:{input:{editor:'index.html',captions:'caption-export.html'}}}, server: {host:'127.0.0.1', port:5173, strictPort:true} });
