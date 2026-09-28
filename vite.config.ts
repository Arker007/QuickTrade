import { defineConfig, type Plugin } from 'vite';
import WebSocket from 'ws';
import type { IncomingMessage, ServerResponse } from 'http';

const AUTH_TOKEN = 'e565c379-17ce-496f-81f5-7edf20e95f77';
const DEVICE_ID = '749d1c4b11ac6319ed036d597cc8770c';
const COOKIE_STRING = `authtoken=${AUTH_TOKEN}; device_id=${DEVICE_ID}; device_type=web;`;
const BINOMO_WS_URL = 'wss://ws.binomo.com/?v=2&vsn=2.0.0';

function binomoWsPlugin(): Plugin {
    let ws: WebSocket | null = null;
    let sseClients: ServerResponse[] = [];
    let refCounter = 6;
    let pingInterval: NodeJS.Timeout | null = null;
    const joinedTopics = new Set<string>();
    const activeAssets = new Set<string>(['Z-CRY/IDX', 'EURO']);

    const broadcastToBrowser = (data: any) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        for (const client of sseClients) {
            try {
                client.write(payload);
                if (typeof (client as any).flush === 'function') {
                    (client as any).flush();
                }
            } catch {
                // Ignore disconnected client write error
            }
        }
    };

    const sendJoin = (topic: string) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (joinedTopics.has(topic)) return;
        joinedTopics.add(topic);
        const ref = String(refCounter++);
        ws.send(JSON.stringify({
            topic,
            event: 'phx_join',
            payload: {},
            ref,
            join_ref: ref,
        }));
    };

    const registerActiveAsset = (asset: string) => {
        if (!asset) return;
        activeAssets.add(asset);
        sendJoin(`asset:${asset}`);
        sendJoin(`range_stream:${asset}`);
    };

    const connectToBinomo = () => {
        if (ws) {
            try {
                ws.removeAllListeners();
                ws.close();
            } catch {
                // ignore
            }
            ws = null;
        }

        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        joinedTopics.clear();

        try {
            ws = new WebSocket(BINOMO_WS_URL, {
                headers: {
                    'Origin': 'https://binomo.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
                    'Accept-Language': 'en-IN,en;q=0.9',
                    'Cookie': COOKIE_STRING,
                },
            });

            ws.on('open', () => {
                console.log('✅ Connected to Binomo WebSocket server successfully!');
                
                // 1. Initial Connection Join Frame
                const connRef = String(refCounter++);
                ws?.send(JSON.stringify({
                    topic: 'connection',
                    event: 'phx_join',
                    payload: {},
                    ref: connRef,
                    join_ref: connRef,
                }));

                // 2. Join all active assets
                for (const asset of activeAssets) {
                    sendJoin(`asset:${asset}`);
                    sendJoin(`range_stream:${asset}`);
                }

                // Correct Phoenix heartbeat ping every 10 seconds to prevent server disconnection
                pingInterval = setInterval(() => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            topic: 'phoenix',
                            event: 'heartbeat',
                            payload: {},
                            ref: String(refCounter++),
                        }));
                    }
                }, 10000);
            });

            ws.on('message', (buffer: WebSocket.RawData) => {
                try {
                    const data = JSON.parse(buffer.toString());
                    if (data.event === 'phx_reply') {
                        // ack
                    }
                    broadcastToBrowser(data);
                } catch {
                    // ignore JSON parse error
                }
            });

            ws.on('close', () => {
                if (pingInterval) clearInterval(pingInterval);
                setTimeout(connectToBinomo, 3000);
            });

            ws.on('error', (err: Error) => {
                console.error('Binomo WebSocket Error:', err.message);
            });
        } catch (err: any) {
            console.error('Failed to initiate Binomo WebSocket:', err.message);
            setTimeout(connectToBinomo, 3000);
        }
    };

    return {
        name: 'binomo-ws-bridge',
        configureServer(server) {
            connectToBinomo();

            server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
                const url = req.url ?? '';
                if (url === '/events' || url.startsWith('/events?') || url === '/api/binomo/events' || url.startsWith('/api/binomo/events?')) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache, no-transform',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no',
                        'Access-Control-Allow-Origin': '*',
                    });
                    res.flushHeaders?.();

                    sseClients.push(res);

                    // Send immediate welcome packet
                    res.write(`data: ${JSON.stringify({ event: 'connected', time: Date.now() })}\n\n`);

                    // Check if asset topic parameter was passed (e.g. /events?asset=Z-CRY/IDX)
                    const parsedUrl = new URL(url, 'http://localhost:3000');
                    const asset = parsedUrl.searchParams.get('asset');
                    if (asset) {
                        const cleanAsset = decodeURIComponent(asset);
                        registerActiveAsset(cleanAsset);
                    }

                    req.on('close', () => {
                        sseClients = sseClients.filter((client) => client !== res);
                    });
                    return;
                }

                if (url.startsWith('/api/binomo/join?')) {
                    const parsedUrl = new URL(url, 'http://localhost:3000');
                    const asset = parsedUrl.searchParams.get('asset');
                    if (asset) {
                        const cleanAsset = decodeURIComponent(asset);
                        registerActiveAsset(cleanAsset);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ok: true, asset }));
                    return;
                }

                next();
            });
        },
    };
}

/**
 * Playground server: `npm run playground` serves playground/ with Vela imported STRAIGHT
 * from src/ (no build step, hot reload).
 */
export default defineConfig({
    root: 'playground',
    plugins: [binomoWsPlugin()],
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
