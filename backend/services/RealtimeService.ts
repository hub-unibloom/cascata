
import { Response, Request } from 'express';
import { Client } from 'pg';
import { systemPool } from '../src/config/main.js';
import { PushService } from './PushService.js';
import { PoolService } from './PoolService.js';
import { quoteId } from '../src/utils/index.js';

interface ClientConnection {
    id: string;
    res: any;
    tableFilter?: string;
}

interface ProjectListener {
    client: Client;
    refCount: number;
    connectionString: string;
    isExternal: boolean;
}

export class RealtimeService {
    private static subscribers = new Map<string, Set<ClientConnection>>();
    
    // Architectual Fix: Track active listeners with Reference Counting
    private static activeListeners = new Map<string, ProjectListener>();
    
    private static MAX_CLIENTS_PER_PROJECT = 5000; 

    public static async handleConnection(req: any, res: any) {
        const slug = req.params.slug;
        const { table } = req.query;
        const project = req.project;

        if (!project) {
            res.status(404).json({ error: 'Project context missing.' });
            return;
        }

        const currentCount = this.subscribers.get(slug)?.size || 0;
        if (currentCount >= this.MAX_CLIENTS_PER_PROJECT) {
            res.status(429).json({ error: 'Too many realtime connections.' });
            return;
        }

        const headers = {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        };
        res.writeHead(200, headers);

        const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

        // Initialize or Increment Listener Reference
        await this.acquireListener(project);

        if (!this.subscribers.has(slug)) {
            this.subscribers.set(slug, new Set());
        }
        
        const connection: ClientConnection = {
            id: clientId,
            res,
            tableFilter: table as string
        };
        
        this.subscribers.get(slug)!.add(connection);

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            this.subscribers.get(slug)?.delete(connection);
            // Decrement or Shutdown Listener
            this.releaseListener(slug);
        });
    }

    private static async acquireListener(project: any) {
        const slug = project.slug;
        
        if (this.activeListeners.has(slug)) {
            const listener = this.activeListeners.get(slug)!;
            listener.refCount++;
            return;
        }

        // Create new Listener
        console.log(`[Realtime] 🟢 Spawning dedicated listener for ${slug}`);
        
        let connectionString: string;
        let isExternal = false;

        if (project.metadata?.external_db_url) {
            connectionString = project.metadata.external_db_url;
            isExternal = true;
        } else {
            const dbName = project.db_name;
            const host = process.env.DB_DIRECT_HOST || 'db';
            const port = process.env.DB_DIRECT_PORT || '5432';
            const user = process.env.DB_USER || 'cascata_admin';
            const pass = process.env.DB_PASS || 'secure_pass';
            connectionString = `postgresql://${user}:${pass}@${host}:${port}/${dbName}`;
        }

        const client = new Client({ 
            connectionString, 
            keepAlive: true,
            ssl: isExternal ? { rejectUnauthorized: false } : false
        });

        try {
            await client.connect();
            await client.query('LISTEN cascata_events');
            
            client.on('notification', (msg) => this.handleNotification(slug, msg));
            client.on('error', (err) => {
                console.error(`[Realtime] Listener Error ${slug}:`, err.message);
                this.forceCloseListener(slug);
            });

            this.activeListeners.set(slug, {
                client,
                refCount: 1,
                connectionString,
                isExternal
            });

        } catch (e: any) {
            console.error(`[Realtime] Failed to connect listener for ${slug}`, e.message);
            throw e;
        }
    }

    private static releaseListener(slug: string) {
        if (!this.activeListeners.has(slug)) return;
        
        const listener = this.activeListeners.get(slug)!;
        listener.refCount--;

        if (listener.refCount <= 0) {
            this.forceCloseListener(slug);
        }
    }

    private static forceCloseListener(slug: string) {
        if (!this.activeListeners.has(slug)) return;
        const listener = this.activeListeners.get(slug)!;
        console.log(`[Realtime] 🔴 Closing idle listener for ${slug}`);
        listener.client.end().catch(() => {});
        this.activeListeners.delete(slug);
    }

    public static teardownProjectListener(slug: string) {
        this.forceCloseListener(slug);
    }

    private static async handleNotification(slug: string, msg: any) {
        if (msg.channel !== 'cascata_events' || !msg.payload) return;

        try {
            const rawPayload = JSON.parse(msg.payload);
            
            // HYDRATION LOGIC (Definitive Phase 2 Fix)
            // If payload has no 'record' but has 'record_id' and 'table', we fetch the data.
            // This prevents the 8kb limit crash in Postgres triggers.
            
            let finalPayload = rawPayload;

            if (!rawPayload.record && rawPayload.record_id && rawPayload.table && rawPayload.action !== 'DELETE') {
                // Fetch the fresh data
                // We use the PoolService here because it's a quick query, not a long-lived listener
                try {
                    const listener = this.activeListeners.get(slug);
                    if (listener) {
                        // Use a separate pool for query to avoid blocking the listener connection if possible,
                        // or just use PoolService which manages this.
                        // We need to resolve the DB Name. Since we are inside the service, we might not have the DB Name handy 
                        // unless we stored it in the listener map or query system.projects.
                        // Optimization: Use the listener connection string to derive context or query directly via PoolService if we know the DB Name.
                        // Since we don't have DB Name easily here, let's use the listener's connection string to get a Pool.
                        // Extract DB Name from connection string is risky (regex).
                        // Better: We query system to get DB Name if needed, OR we just trust the client app to re-fetch.
                        
                        // Decision: For Phase 2 Stability, we implement Server-Side Hydration to maintain compatibility.
                        // We will use the connection string from the listener to spawn a temporary Pool query.
                        
                        // Note: To avoid overhead, we use PoolService.get with the connection string directly.
                        // We can use a dummy name since we provide the connectionString.
                        const pool = PoolService.get(`rt_hydration_${slug}`, { connectionString: listener.connectionString });
                        
                        const res = await pool.query(`SELECT * FROM public.${quoteId(rawPayload.table)} WHERE id = $1`, [rawPayload.record_id]);
                        if (res.rows.length > 0) {
                            finalPayload.record = res.rows[0];
                        }
                    }
                } catch (err) {
                    console.warn(`[Realtime] Hydration failed for ${slug}`, err);
                    // Fallback: Send without record, client might fetch it.
                }
            }

            // Trigger Push Engine (Neural Pulse)
            // This logic is decoupled from the socket broadcast
            // We fire and forget this check
            this.triggerNeuralPulse(slug, finalPayload);

            // Broadcast to connected clients
            this.broadcast(slug, finalPayload);

        } catch (e) {
            console.error(`[Realtime] Parse Error`, e);
        }
    }

    private static async triggerNeuralPulse(slug: string, payload: any) {
        try {
            // Check if project has firebase config (cached check would be better, but db check is safe for Phase 2)
            const projRes = await systemPool.query('SELECT db_name, metadata FROM system.projects WHERE slug = $1', [slug]);
            const project = projRes.rows[0];
            
            if (project?.metadata?.firebase_config) {
                const pool = PoolService.get(project.db_name, { connectionString: project.metadata?.external_db_url });
                PushService.processEventTrigger(
                    slug, 
                    pool, 
                    systemPool, 
                    payload, 
                    project.metadata.firebase_config
                ).catch(() => {});
            }
        } catch (e) {}
    }

    private static broadcast(slug: string, payload: any) {
        const clients = this.subscribers.get(slug);
        if (!clients) return;
        const message = `data: ${JSON.stringify(payload)}\n\n`;
        clients.forEach(client => {
            if (!client.res.writableEnded) {
                if (!client.tableFilter || client.tableFilter === payload.table) {
                    client.res.write(message);
                }
            }
        });
    }
}
