import { defineConfig } from 'vite';

/**
 * Playground server: `npm run playground` serves playground/ with Vela imported STRAIGHT
 * from src/ (no build step, hot reload). Nothing else to configure — Vela ships no
 * scripting engine, so the page carries its own tiny demo engine (playground/demo-engine.ts)
 * and needs no bundler plumbing for it.
 */
export default defineConfig({
    root: 'playground',
    optimizeDeps: {
        include: ['@luxalgo/vela-pinets', 'pinets'],
    },
    server: {
        port: 3000,
        host: '0.0.0.0',
        allowedHosts: 'all',
        proxy: {
            '/api/binomo': {
                target: 'https://api.binomo.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/binomo/, ''),
            },
            '/api/biquote': {
                target: 'https://biquote.io/api',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/biquote/, ''),
            },
        }
    },
});
