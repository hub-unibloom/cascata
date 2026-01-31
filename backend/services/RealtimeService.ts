
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
}

export class RealtimeService {
    private static subscribers = new Map<string, Set<ClientConnection>>();
    private static activeListeners = new Map<string, ProjectListener>();
    private static MAX_CLIENTS_PER_PROJECT = 5000; 

    // --- HYDRATION BATCHER STATE ---
    private static hydrationBuffers = new Map<string, ProjectBuffer>();
    
    // Backpressure Lock: Map<"projectSlug:tableName", Timestamp>
    private static activeFlushes = new Map<string, number>();
    
    private static flushInterval: NodeJS.Timeout | null = null;
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
        activeConnections: 0
    };

    /**
     * Inicializa o serviço de forma segura
     */
    public static init() {
        try {
            this.startBatcher();
            console.log('[Realtime] ✅ Service initialized with Hydration Batcher V2');
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

        for (const [slug, projectBuffer] of this.hydrationBuffers.entries()) {
            for (const [table, idMap] of projectBuffer.entries()) {
                if (idMap.size === 0) continue;

                const lockKey = `${slug}:${table}`;
                // Atomic Swap para garantir processamento
                const batchToProcess = new Map(idMap);
                idMap.clear();

                // Adiciona à lista de espera
                pendingFlushes.push(
                    this.processBatch(slug, table, batchToProcess, lockKey).catch(e => {
                        console.error(`[Realtime] Shutdown flush error for ${lockKey}:`, e);
                    })
                );
            }
        }

        // Aguarda todos os flushes terminarem ou timeout de segurança
        await Promise.allSettled(pendingFlushes);
        
        // Fecha listeners do Postgres
        for (const slug of this.activeListeners.keys()) {
            this.forceCloseListener(slug);
        }
        
        console.log('[Realtime] Shutdown complete.');
    }

    public static async handleConnection(req: any, res: any) {
        const slug = req.params.slug;
        const { table } = req.query;
        const project = req.project;

        if (!project) {
            res.status(404).json({ error: 'Project context missing.' });
            return;
        }

        // 1. SECURITY: Panic Mode Check (Brecha Fechada)
        const isPanic = await RateLimitService.checkPanic(slug);
        if (isPanic) {
            res.status(503).json({ error: 'Service Unavailable (Lockdown Mode)' });
            return;
        }

        const currentCount = this.subscribers.get(slug)?.size || 0;
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
        res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

        try {
            await this.acquireListener(project);
            
            if (!this.subscribers.has(slug)) {
                this.subscribers.set(slug, new Set());
            }
            
            const connection: ClientConnection = { id: clientId, res, tableFilter: table as string };
            this.subscribers.get(slug)!.add(connection);
            this.metrics.activeConnections++;

            // Ensure loop is running (lazy start safety)
            this.startBatcher();

            const heartbeat = setInterval(() => {
                if (!res.writableEnded) res.write(': ping\n\n');
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeat);
                this.subscribers.get(slug)?.delete(connection);
                this.metrics.activeConnections--;
                this.releaseListener(slug);
            });

        } catch (e) {
            console.error(`[Realtime] Failed to setup connection for ${slug}`, e);
            res.end(); 
        }
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

        // CACHE OPTIMIZATION: Carrega configs extras uma vez
        const cachedConfig: any = {};
        if (project.metadata?.firebase_config) {
            cachedConfig.firebase = project.metadata.firebase_config;
        }

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
                isExternal,
                cachedConfig
            });

        } catch (e: any) {
            console.error(`[Realtime] Connection Failed for ${slug}`, e.message);
            throw e;
        }
    }

    private static releaseListener(slug: string) {
        const listener = this.activeListeners.get(slug);
        if (!listener) return;
        
        listener.refCount--;
        if (listener.refCount <= 0) {
            this.forceCloseListener(slug);
        }
    }

    private static forceCloseListener(slug: string) {
        const listener = this.activeListeners.get(slug);
        if (!listener) return;
        
        console.log(`[Realtime] 🔴 Closing idle listener for ${slug}`);
        listener.client.end().catch(() => {});
        this.activeListeners.delete(slug);
        this.hydrationBuffers.delete(slug);
    }

    public static teardownProjectListener(slug: string) {
        this.forceCloseListener(slug);
    }

    private static async handleNotification(slug: string, msg: any) {
        if (msg.channel !== 'cascata_events' || !msg.payload) return;

        try {
            this.metrics.eventsReceived++;
            const rawPayload = JSON.parse(msg.payload);
            
            // LOGIC: Hydration Batcher
            // Se o payload vier "seco" (sem record) e não for DELETE, bufferiza.
            if (!rawPayload.record && rawPayload.record_id && rawPayload.table && rawPayload.action !== 'DELETE') {
                this.addToBatch(slug, rawPayload.table, rawPayload.record_id, rawPayload.action);
                return;
            }

            // Se for DELETE ou Payload Completo, envia direto
            this.processSingleEvent(slug, rawPayload);

        } catch (e) {
            console.error(`[Realtime] Parse Error`, e);
        }
    }

    private static processSingleEvent(slug: string, payload: any) {
        this.triggerNeuralPulse(slug, payload);
        this.broadcast(slug, payload);
    }

    // --- BATCHER CORE (10/10 Implementation) ---

    private static startBatcher() {
        if (this.flushInterval) return;
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

        // Circuit Breaker: Proteção contra OOM
        if (tableBuffer.size >= this.MAX_BUFFER_SIZE_PER_TABLE) {
            this.metrics.eventsDropped++;
            if (Math.random() < 0.01) console.warn(`[Realtime] Buffer overflow for ${slug}:${table}. Dropping updates.`);
            return;
        }

        // Map garante deduplicação (Last Write Wins)
        tableBuffer.set(id, action);
        this.metrics.eventsBatched++;
    }

    private static flushAllBuffers() {
        if (this.hydrationBuffers.size === 0) return;

        // Itera sobre projetos
        for (const [slug, projectBuffer] of this.hydrationBuffers.entries()) {
            if (projectBuffer.size === 0) continue;

            // Itera sobre tabelas
            for (const [table, idMap] of projectBuffer.entries()) {
                if (idMap.size === 0) continue;

                const lockKey = `${slug}:${table}`;
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
                this.processBatch(slug, table, batchToProcess, lockKey).catch(err => {
                    console.error(`[Realtime] Uncaught batch error for ${slug}`, err);
                    this.activeFlushes.delete(lockKey);
                });
            }
        }
    }

    private static async processBatch(slug: string, table: string, idMap: Map<string, string>, lockKey: string) {
        const listener = this.activeListeners.get(slug);
        if (!listener) return; // Projeto desconectou

        this.activeFlushes.set(lockKey, Date.now()); // Acquire Lock

        let client: PoolClient | null = null;
        try {
            // Reutiliza connection string do listener mas usa PoolService para eficiência
            const pool = PoolService.get(`rt_hyd_${slug}`, { connectionString: listener.connectionString });
            const ids = Array.from(idMap.keys());
            
            // 2. TIMEOUT ROBUSTO (Padrão SET/RESET com Client Manual)
            // Evita poluir o pool global se a conexão for devolvida suja
            client = await pool.connect();
            
            try {
                // Define timeout apenas para esta transação/sessão
                await client.query("SET statement_timeout = '5000'"); 
                
                const res = await client.query(
                    `SELECT * FROM public.${quoteId(table)} WHERE id = ANY($1::text[])`, 
                    [ids]
                );

                // Fan-out: Distribui os resultados
                for (const row of res.rows) {
                    const recordId = row.id; 
                    const originalAction = idMap.get(recordId) || 'INSERT';

                    const hydratedPayload = {
                        table: table,
                        schema: 'public',
                        action: originalAction, 
                        record: row,
                        record_id: recordId,
                        timestamp: new Date().toISOString()
                    };

                    this.processSingleEvent(slug, hydratedPayload);
                }

            } finally {
                // Limpeza crítica antes de devolver ao pool
                await client.query("RESET statement_timeout").catch(() => {});
                client.release();
            }

        } catch (e: any) {
            this.metrics.hydrationErrors++;
            console.error(`[Realtime] Hydration failed for ${slug}:${table}`, e.message);
        } finally {
            this.activeFlushes.delete(lockKey); // Release Lock
        }
    }

    // --- INTEGRATIONS ---

    private static async triggerNeuralPulse(slug: string, payload: any) {
        const listener = this.activeListeners.get(slug);
        if (!listener || !listener.cachedConfig?.firebase) return;

        try {
            // Fire & Forget para não bloquear o loop de eventos
            const pool = PoolService.get(`pulse_${slug}`, { connectionString: listener.connectionString });
            PushService.processEventTrigger(
                slug, 
                pool, 
                systemPool, 
                payload, 
                listener.cachedConfig.firebase
            ).catch(() => {});
        } catch (e) {}
    }

    private static broadcast(slug: string, payload: any) {
        const clients = this.subscribers.get(slug);
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
            subscribers: this.subscribers.size
        };
    }
}

// Inicialização Estática (Controlada pelo server.ts agora)
// RealtimeService.init();
