

import { Response, Request } from 'express';
import { Client, PoolClient } from 'pg';
import { systemPool } from '../src/config/main.js';
import { PushService } from './PushService.js';
import { PoolService } from './PoolService.js';
import { RateLimitService } from './RateLimitService.js';
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
    // Cache de configurações para evitar DB hits em cada evento
    cachedConfig?: {
        firebase?: any;
        draft_sync?: boolean; // NEW: Cache the sync setting
    };
}

// BATCHER INTERFACES
// Map<TableName, Map<RecordID, ActionType>>
type TableBuffer = Map<string, string>; 
type ProjectBuffer = Map<string, TableBuffer>;

// OBSERVABILITY METRICS
interface ServiceMetrics {
    eventsReceived: number;
    eventsBatched: number;
    eventsBroadcasted: number;
    eventsDropped: number; // Circuit Breaker
    hydrationErrors: number;
    activeConnections: number;
    mirroredEvents: number; // NEW
}

export class RealtimeService {
    // Key is now `${slug}:${env}` to separate Live vs Draft channels
    private static subscribers = new Map<string, Set<ClientConnection>>();
    private static activeListeners = new Map<string, ProjectListener>();
    private static MAX_CLIENTS_PER_PROJECT = 5000; 

    // --- HYDRATION BATCHER STATE ---
    // Key is now `${slug}:${env}`
    private static hydrationBuffers = new Map<string, ProjectBuffer>();
    
    // Backpressure Lock: Map<"projectSlug:env:tableName", Timestamp>
    private static activeFlushes = new Map<string, number>();
    
    private static flushInterval: any = null;
    private static readonly BATCH_TICK_MS = 50; 
    private static readonly MAX_BUFFER_SIZE_PER_TABLE = 5000; 
    private static readonly LOCK_TIMEOUT_MS = 30000; // 30s max para um flush

    // METRICS STATE
    public static metrics: ServiceMetrics = {
        eventsReceived: 0,
        eventsBatched: 0,
        eventsBroadcasted: 0,
        eventsDropped: 0,
        hydrationErrors: 0,
        activeConnections: 0,
        mirroredEvents: 0
    };

    /**
     * Inicializa o serviço de forma segura
     */
    public static init() {
        try {
            this.startBatcher();
            console.log('[Realtime] ✅ Service initialized with Hydration Batcher V2 (Env Aware)');
        } catch (e) {
            console.error('[Realtime] ❌ Initialization failed', e);
            throw e; // Falha no boot é crítica
        }
    }

    /**
     * Shutdown Gracioso invocado pelo servidor central
     * Garante que buffers sejam processados antes de fechar conexões
     */
    public static async shutdown() {
        console.log('[Realtime] Shutting down... flushing buffers.');
        if (this.flushInterval) clearInterval(this.flushInterval);
        
        // Coleta todas as promessas de flush pendentes
        const pendingFlushes: Promise<void>[] = [];

        for (const [key, projectBuffer] of this.hydrationBuffers.entries()) {
            const [slug, env] = key.split(':'); // Extract context

            for (const [table, idMap] of projectBuffer.entries()) {
                if (idMap.size === 0) continue;

                const lockKey = `${key}:${table}`;
                // Atomic Swap para garantir processamento
                const batchToProcess = new Map(idMap);
                idMap.clear();

                // Adiciona à lista de espera
                pendingFlushes.push(
                    this.processBatch(slug, env || 'live', table, batchToProcess, lockKey).catch(e => {
                        console.error(`[Realtime] Shutdown flush error for ${lockKey}:`, e);
                    })
                );
            }
        }

        // Aguarda todos os flushes terminarem ou timeout de segurança
        await Promise.allSettled(pendingFlushes);
        
        // Fecha listeners do Postgres
        for (const key of this.activeListeners.keys()) {
            this.forceCloseListener(key);
        }
        
        console.log('[Realtime] Shutdown complete.');
    }

    public static async handleConnection(req: any, res: any) {
        const slug = req.params.slug;
        const { table, env } = req.query; // Environment param
        const project = req.project;

        if (!project) {
            res.status(404).json({ error: 'Project context missing.' });
            return;
        }

        // Determine Environment context
        const targetEnv = env === 'draft' ? 'draft' : 'live';
        const contextKey = `${slug}:${targetEnv}`;

        // 1. SECURITY: Panic Mode Check (Brecha Fechada)
        const isPanic = await RateLimitService.checkPanic(slug);
        if (isPanic) {
            res.status(503).json({ error: 'Service Unavailable (Lockdown Mode)' });
            return;
        }

        const currentCount = this.subscribers.get(contextKey)?.size || 0;
        if (currentCount >= this.MAX_CLIENTS_PER_PROJECT) {
            res.status(429).json({ error: 'Too many realtime connections.' });
            return;
        }

        // Headers SSE Padrão
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        });

        const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        res.write(`data: ${JSON.stringify({ type: 'connected', clientId, env: targetEnv })}\n\n`);

        try {
            // Acquire listener for specific environment
            await this.acquireListener(project, targetEnv);
            
            if (!this.subscribers.has(contextKey)) {
                this.subscribers.set(contextKey, new Set());
            }
            
            const connection: ClientConnection = { id: clientId, res, tableFilter: table as string };
            this.subscribers.get(contextKey)!.add(connection);
            this.metrics.activeConnections++;

            // Ensure loop is running (lazy start safety)
            this.startBatcher();

            const heartbeat = setInterval(() => {
                if (!res.writableEnded) res.write(': ping\n\n');
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeat);
                this.subscribers.get(contextKey)?.delete(connection);
                this.metrics.activeConnections--;
                this.releaseListener(contextKey);
            });

        } catch (e) {
            console.error(`[Realtime] Failed to setup connection for ${contextKey}`, e);
            res.end(); 
        }
    }

    private static async acquireListener(project: any, env: string) {
        const slug = project.slug;
        const contextKey = `${slug}:${env}`;
        
        if (this.activeListeners.has(contextKey)) {
            const listener = this.activeListeners.get(contextKey)!;
            listener.refCount++;
            
            // Refresh Config Cache occasionally
            if (Math.random() < 0.05) {
                 listener.cachedConfig = {
                    firebase: project.metadata?.firebase_config,
                    draft_sync: project.metadata?.draft_sync_active
                 };
            }
            return;
        }

        console.log(`[Realtime] 🟢 Spawning dedicated listener for ${contextKey}`);
        
        let connectionString: string;
        let isExternal = false;

        if (project.metadata?.external_db_url) {
            connectionString = project.metadata.external_db_url;
            isExternal = true;
        } else {
            let dbName = project.db_name;
            if (env === 'draft') {
                dbName = `${dbName}_draft`;
            }
            
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

        // CACHE OPTIMIZATION: Carrega configs extras uma vez
        const cachedConfig: any = {};
        if (project.metadata?.firebase_config) {
            cachedConfig.firebase = project.metadata.firebase_config;
        }
        // NEW: Check if Sync is active
        cachedConfig.draft_sync = project.metadata?.draft_sync_active === true;

        try {
            await client.connect();
            await client.query('LISTEN cascata_events');
            
            client.on('notification', (msg) => this.handleNotification(slug, env, msg));
            client.on('error', (err) => {
                console.error(`[Realtime] Listener Error ${contextKey}:`, err.message);
                this.forceCloseListener(contextKey);
            });

            this.activeListeners.set(contextKey, {
                client,
                refCount: 1,
                connectionString,
                isExternal,
                cachedConfig
            });

        } catch (e: any) {
            console.error(`[Realtime] Connection Failed for ${contextKey}`, e.message);
            throw e;
        }
    }

    private static releaseListener(contextKey: string) {
        const listener = this.activeListeners.get(contextKey);
        if (!listener) return;
        
        listener.refCount--;
        if (listener.refCount <= 0) {
            this.forceCloseListener(contextKey);
        }
    }

    private static forceCloseListener(contextKey: string) {
        const listener = this.activeListeners.get(contextKey);
        if (!listener) return;
        
        console.log(`[Realtime] 🔴 Closing idle listener for ${contextKey}`);
        listener.client.end().catch(() => {});
        this.activeListeners.delete(contextKey);
        this.hydrationBuffers.delete(contextKey);
    }

    public static teardownProjectListener(slug: string) {
        // Close both live and draft if they exist
        this.forceCloseListener(`${slug}:live`);
        this.forceCloseListener(`${slug}:draft`);
    }

    private static async handleNotification(slug: string, env: string, msg: any) {
        if (msg.channel !== 'cascata_events' || !msg.payload) return;

        try {
            this.metrics.eventsReceived++;
            const rawPayload = JSON.parse(msg.payload);
            
            // LOGIC: Hydration Batcher
            // Se o payload vier "seco" (sem record) e não for DELETE, bufferiza.
            if (!rawPayload.record && rawPayload.record_id && rawPayload.table && rawPayload.action !== 'DELETE') {
                this.addToBatch(slug, env, rawPayload.table, rawPayload.record_id, rawPayload.action);
                return;
            }

            // Se for DELETE ou Payload Completo, envia direto
            this.processSingleEvent(slug, env, rawPayload);

        } catch (e) {
            console.error(`[Realtime] Parse Error`, e);
        }
    }

    private static processSingleEvent(slug: string, env: string, payload: any) {
        // Trigger Push only for Live events usually, but for dev consistency we allow both.
        // The PushService handles logic internally if needed.
        this.triggerNeuralPulse(slug, env, payload);
        
        // NEW: Live Mirroring (Live -> Draft)
        if (env === 'live') {
            this.mirrorToDraft(slug, payload);
        }

        this.broadcast(slug, env, payload);
    }

    // --- NEW: LIVE MIRRORING ENGINE ---
    private static async mirrorToDraft(slug: string, payload: any) {
        const listener = this.activeListeners.get(`${slug}:live`);
        
        // Check if sync is enabled in cached config
        if (!listener || !listener.cachedConfig?.draft_sync) return;

        // Skip if Draft listener not active? No, we should try to push even if no one is listening on draft UI
        // But we need a connection. We use PoolService for the Draft DB.
        
        try {
            // Assume Draft DB exists if sync is active
            const draftDbName = listener.connectionString.split('/').pop()?.split('?')[0] + '_draft';
            // We need to reconstruct connection string for Draft, assuming managed DB structure
            // NOTE: This assumes standard Cascata managed DB naming convention.
            
            // Safe fallback: Retrieve DB name from metadata if possible, but here we only have slug/connString.
            // We use the live conn string and append _draft if it's a managed db.
            // If it's external, mirroring is harder, we skip for now or need explicit config.
            if (listener.isExternal) return; 

            // Create a pool key for the draft writer
            const draftPoolKey = `mirror_${slug}`;
            const host = process.env.DB_DIRECT_HOST || 'db';
            const port = process.env.DB_DIRECT_PORT || '5432';
            const user = process.env.DB_USER || 'cascata_admin';
            const pass = process.env.DB_PASS || 'secure_pass';
            
            // Construct Draft Connection
            // We parse the LIVE connection string to handle potential different hosts/users, 
            // but for managed, we can construct standard.
            const draftConnString = `postgresql://${user}:${pass}@${host}:${port}/${draftDbName}`;
            
            const pool = PoolService.get(draftPoolKey, { connectionString: draftConnString });
            const client = await pool.connect();

            try {
                const { table, action, record, record_id } = payload;
                const safeTable = quoteId(table);

                if (action === 'DELETE') {
                    await client.query(`DELETE FROM public.${safeTable} WHERE id = $1`, [record_id]);
                } else if (record) {
                    const keys = Object.keys(record);
                    const cols = keys.map(k => quoteId(k)).join(', ');
                    const vals = Object.values(record);
                    const placeholders = vals.map((_, i) => `$${i+1}`).join(', ');
                    
                    // UPSERT STRATEGY (Mirroring)
                    // On conflict update everything to match Live
                    const updates = keys.map(k => `${quoteId(k)} = EXCLUDED.${quoteId(k)}`).join(', ');

                    await client.query(
                        `INSERT INTO public.${safeTable} (${cols}) VALUES (${placeholders})
                         ON CONFLICT (id) DO UPDATE SET ${updates}`,
                        vals
                    );
                }
                this.metrics.mirroredEvents++;
            } finally {
                client.release();
            }

        } catch (e) {
            // Silently fail mirroring to not impact Live performance, but log it
            // console.warn(`[Realtime] Mirroring failed for ${slug}`, e); 
        }
    }

    // --- BATCHER CORE ---

    private static startBatcher() {
        if (this.flushInterval) return;
        this.flushInterval = setInterval(() => this.flushAllBuffers(), this.BATCH_TICK_MS);
    }

    private static addToBatch(slug: string, env: string, table: string, id: string, action: string) {
        const contextKey = `${slug}:${env}`;
        
        if (!this.hydrationBuffers.has(contextKey)) {
            this.hydrationBuffers.set(contextKey, new Map());
        }
        const projectBuffer = this.hydrationBuffers.get(contextKey)!;

        if (!projectBuffer.has(table)) {
            projectBuffer.set(table, new Map());
        }
        const tableBuffer = projectBuffer.get(table)!;

        // Circuit Breaker: Proteção contra OOM
        if (tableBuffer.size >= this.MAX_BUFFER_SIZE_PER_TABLE) {
            this.metrics.eventsDropped++;
            if (Math.random() < 0.01) console.warn(`[Realtime] Buffer overflow for ${contextKey}:${table}. Dropping updates.`);
            return;
        }

        // Map garante deduplicação (Last Write Wins)
        tableBuffer.set(id, action);
        this.metrics.eventsBatched++;
    }

    private static flushAllBuffers() {
        if (this.hydrationBuffers.size === 0) return;

        // Itera sobre contextos (slug:env)
        for (const [contextKey, projectBuffer] of this.hydrationBuffers.entries()) {
            if (projectBuffer.size === 0) continue;
            
            const [slug, env] = contextKey.split(':');

            // Itera sobre tabelas
            for (const [table, idMap] of projectBuffer.entries()) {
                if (idMap.size === 0) continue;

                const lockKey = `${contextKey}:${table}`;
                const lastLockTime = this.activeFlushes.get(lockKey);
                const now = Date.now();

                // BACKPRESSURE & LOCK TIMEOUT
                if (lastLockTime) {
                    if (now - lastLockTime > this.LOCK_TIMEOUT_MS) {
                         console.warn(`[Realtime] Lock timeout for ${lockKey}. Forcing unlock.`);
                         this.activeFlushes.delete(lockKey);
                    } else {
                         // Ainda bloqueado e dentro do tempo, pula este tick
                         continue; 
                    }
                }

                // ATOMIC SWAP: Clone & Clear
                const batchToProcess = new Map(idMap);
                idMap.clear();

                // Fire and Forget (Catching errors internally)
                this.processBatch(slug, env, table, batchToProcess, lockKey).catch(err => {
                    console.error(`[Realtime] Uncaught batch error for ${slug}`, err);
                    this.activeFlushes.delete(lockKey);
                });
            }
        }
    }

    private static async processBatch(slug: string, env: string, table: string, idMap: Map<string, string>, lockKey: string) {
        const contextKey = `${slug}:${env}`;
        const listener = this.activeListeners.get(contextKey);
        if (!listener) return; // Projeto desconectou

        this.activeFlushes.set(lockKey, Date.now()); // Acquire Lock

        let client: PoolClient | null = null;
        try {
            // Reutiliza connection string do listener mas usa PoolService para eficiência
            // Pool key needs to be unique per DB to avoid mixing
            const poolKey = `rt_hyd_${slug}_${env}`;
            const pool = PoolService.get(poolKey, { connectionString: listener.connectionString });
            const ids = Array.from(idMap.keys());
            
            // SMART CASTING LOGIC (Security & Stability)
            let castType = 'text';
            if (ids.length > 0) {
                const sample = ids[0];
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sample)) {
                    castType = 'uuid';
                } else if (/^-?\d+$/.test(sample)) {
                    castType = 'bigint';
                }
            }

            // 2. TIMEOUT ROBUSTO (Padrão SET/RESET com Client Manual)
            client = await pool.connect();
            
            try {
                await client.query("SET statement_timeout = '5000'"); 
                
                const res = await client.query(
                    `SELECT * FROM public.${quoteId(table)} WHERE id = ANY($1::${castType}[])`, 
                    [ids]
                );

                // Fan-out: Distribui os resultados
                for (const row of res.rows) {
                    const recordId = row.id; 
                    const originalAction = idMap.get(String(recordId)) || 'INSERT';

                    const hydratedPayload = {
                        table: table,
                        schema: 'public',
                        action: originalAction, 
                        record: row,
                        record_id: recordId,
                        timestamp: new Date().toISOString()
                    };

                    this.processSingleEvent(slug, env, hydratedPayload);
                }

            } finally {
                await client.query("RESET statement_timeout").catch(() => {});
                client.release();
            }

        } catch (e: any) {
            this.metrics.hydrationErrors++;
            console.error(`[Realtime] Hydration failed for ${contextKey}:${table}`, e.message);
        } finally {
            this.activeFlushes.delete(lockKey); // Release Lock
        }
    }

    // --- INTEGRATIONS ---

    private static async triggerNeuralPulse(slug: string, env: string, payload: any) {
        const contextKey = `${slug}:${env}`;
        const listener = this.activeListeners.get(contextKey);
        
        // Push only active on Live env typically, but we support Draft if credentials match
        if (!listener || !listener.cachedConfig?.firebase) return;

        try {
            // Fire & Forget para não bloquear o loop de eventos
            const poolKey = `pulse_${slug}_${env}`;
            const pool = PoolService.get(poolKey, { connectionString: listener.connectionString });
            
            PushService.processEventTrigger(
                slug, 
                pool, 
                systemPool, 
                payload, 
                listener.cachedConfig.firebase
            ).catch(() => {});
        } catch (e) {}
    }

    private static broadcast(slug: string, env: string, payload: any) {
        const contextKey = `${slug}:${env}`;
        const clients = this.subscribers.get(contextKey);
        if (!clients || clients.size === 0) return;
        
        const message = `data: ${JSON.stringify(payload)}\n\n`;
        let sentCount = 0;
        
        clients.forEach(client => {
            if (!client.res.writableEnded) {
                if (!client.tableFilter || client.tableFilter === payload.table) {
                    client.res.write(message);
                    sentCount++;
                }
            }
        });
        
        this.metrics.eventsBroadcasted += sentCount;
    }

    // --- PUBLIC METRICS ACCESS ---
    public static getMetrics() {
        return {
            ...this.metrics,
            buffers: this.hydrationBuffers.size,
            listeners: this.activeListeners.size,
            subscribers: Array.from(this.subscribers.values()).reduce((acc, set) => acc + set.size, 0)
        };
    }
}
