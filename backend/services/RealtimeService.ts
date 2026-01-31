
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

// BATCHER INTERFACES
// Map<TableName, Map<RecordID, ActionType>>
// Stores ID and Action (INSERT/UPDATE) to preserve context
type TableBuffer = Map<string, string>; 
type ProjectBuffer = Map<string, TableBuffer>;

export class RealtimeService {
    private static subscribers = new Map<string, Set<ClientConnection>>();
    private static activeListeners = new Map<string, ProjectListener>();
    private static MAX_CLIENTS_PER_PROJECT = 5000; 

    // --- HYDRATION BATCHER STATE ---
    // Map<ProjectSlug, Map<TableName, Map<RecordId, Action>>>
    private static hydrationBuffers = new Map<string, ProjectBuffer>();
    
    // Backpressure Lock: Set<"projectSlug:tableName">
    // Prevents parallel fetches for the same table to save DB connection limit
    private static activeFlushes = new Set<string>();
    
    private static flushInterval: NodeJS.Timeout | null = null;
    private static readonly BATCH_TICK_MS = 50; // 50ms aggregation window
    private static readonly MAX_BUFFER_SIZE_PER_TABLE = 5000; // Circuit breaker

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

        // Ensure the batcher loop is alive
        this.startBatcher();

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            this.subscribers.get(slug)?.delete(connection);
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
        
        // Clean up buffer if exists
        this.hydrationBuffers.delete(slug);
    }

    public static teardownProjectListener(slug: string) {
        this.forceCloseListener(slug);
    }

    private static async handleNotification(slug: string, msg: any) {
        if (msg.channel !== 'cascata_events' || !msg.payload) return;

        try {
            const rawPayload = JSON.parse(msg.payload);
            
            // HYDRATION BATCHER LOGIC
            // Only batch if it's a lightweight payload (missing full record) AND NOT a DELETE.
            // Deletes cannot be hydrated because the record is gone.
            if (!rawPayload.record && rawPayload.record_id && rawPayload.table && rawPayload.action !== 'DELETE') {
                this.addToBatch(slug, rawPayload.table, rawPayload.record_id, rawPayload.action);
                return; // Stop here, batcher will process later
            }

            // If it's a DELETE or full payload, send immediately
            this.triggerNeuralPulse(slug, rawPayload);
            this.broadcast(slug, rawPayload);

        } catch (e) {
            console.error(`[Realtime] Parse Error`, e);
        }
    }

    // --- BATCHER CORE ---

    private static startBatcher() {
        if (this.flushInterval) return;
        // Global Tick Loop - runs once for the entire Node process
        this.flushInterval = setInterval(() => this.flushAllBuffers(), this.BATCH_TICK_MS);
    }

    private static addToBatch(slug: string, table: string, id: string, action: string) {
        if (!this.hydrationBuffers.has(slug)) {
            this.hydrationBuffers.set(slug, new Map());
        }
        const projectBuffer = this.hydrationBuffers.get(slug)!;

        if (!projectBuffer.has(table)) {
            projectBuffer.set(table, new Map());
        }
        const tableBuffer = projectBuffer.get(table)!;

        // Circuit Breaker: Protection against Memory Overflow
        if (tableBuffer.size >= this.MAX_BUFFER_SIZE_PER_TABLE) {
            // Drop event to protect process memory. 
            // In a production system, we might want to log this metric or spill to Redis.
            if (Math.random() < 0.01) console.warn(`[Realtime] Buffer overflow for ${slug}:${table}. Dropping updates.`);
            return;
        }

        // Add to map: Last Write Wins for the action
        tableBuffer.set(id, action);
    }

    private static flushAllBuffers() {
        if (this.hydrationBuffers.size === 0) return;

        // Iterate over projects
        for (const [slug, projectBuffer] of this.hydrationBuffers.entries()) {
            if (projectBuffer.size === 0) continue;

            // Iterate over tables within project
            for (const [table, idMap] of projectBuffer.entries()) {
                if (idMap.size === 0) continue;

                // BACKPRESSURE CHECK:
                // If a flush is already running for this table, SKIP this tick.
                // This allows the buffer to accumulate more items (efficiency) and prevents
                // opening too many DB connections if the DB is slow.
                const lockKey = `${slug}:${table}`;
                if (this.activeFlushes.has(lockKey)) {
                    continue; 
                }

                // ATOMIC SWAP:
                // Clone and clear immediately to unblock new inserts.
                // We convert Map to a plain object/array for processing.
                const batchToProcess = new Map(idMap);
                idMap.clear();

                // Fire and Forget (Async)
                this.processBatch(slug, table, batchToProcess, lockKey);
            }
        }
    }

    private static async processBatch(slug: string, table: string, idMap: Map<string, string>, lockKey: string) {
        const listener = this.activeListeners.get(slug);
        if (!listener) return; // Project disconnected

        this.activeFlushes.add(lockKey);

        try {
            // Use PoolService for the transient query
            // We reuse the connection info from the listener, but use the pool for query efficiency
            const pool = PoolService.get(`rt_hyd_${slug}`, { connectionString: listener.connectionString });
            
            const ids = Array.from(idMap.keys());
            
            // Optimized Batch Fetch: 1 Query for N rows
            const res = await pool.query(
                `SELECT * FROM public.${quoteId(table)} WHERE id = ANY($1::text[])`, 
                [ids] 
            );

            // Fan-out results
            // We iterate the results found. Note: Some IDs might be missing if they were deleted
            // immediately after insert (race condition), which is fine to ignore.
            for (const row of res.rows) {
                const recordId = row.id;
                const originalAction = idMap.get(recordId) || 'INSERT'; // Fallback to INSERT

                const hydratedPayload = {
                    table: table,
                    schema: 'public',
                    action: originalAction, 
                    record: row,
                    record_id: recordId,
                    timestamp: new Date().toISOString()
                };

                this.triggerNeuralPulse(slug, hydratedPayload);
                this.broadcast(slug, hydratedPayload);
            }

        } catch (e: any) {
            console.error(`[Realtime] Batch hydration failed for ${slug}:${table}`, e.message);
        } finally {
            // Always release the lock
            this.activeFlushes.delete(lockKey);
        }
    }

    // --- EXISTING HELPERS ---

    private static async triggerNeuralPulse(slug: string, payload: any) {
        try {
            // Optimization: In Phase 3, cache this config to avoid DB hit on every event
            const projRes = await systemPool.query('SELECT db_name, metadata FROM system.projects WHERE slug = $1', [slug]);
            const project = projRes.rows[0];
            
            if (project?.metadata?.firebase_config) {
                // If using external DB, we need the connection string, else internal pool logic
                const connectionString = project.metadata?.external_db_url;
                const pool = PoolService.get(project.db_name, { connectionString });
                
                // Fire and forget push processing
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
