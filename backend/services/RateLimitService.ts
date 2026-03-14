
import { Redis as DragonflyClient } from 'ioredis';
import { Pool } from 'pg';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { LRUCache } from 'lru-cache';
import { systemPool } from '../src/config/main.js';

// --- INTERFACES ---
interface RateLimitRule {
    id: string;
    project_slug: string;
    route_pattern: string;
    method: string;
    rate_limit: number;
    burst_limit: number;
    rate_limit_anon?: number;
    burst_limit_anon?: number;
    rate_limit_auth?: number;
    burst_limit_auth?: number;
    crud_limits?: {
        anon?: CrudConfig;
        auth?: CrudConfig;
    };
    group_limits?: Record<string, {
        rate: number;
        burst: number;
        crud?: CrudConfig;
    }>;
    window_seconds: number;
    message_anon?: string;
    message_auth?: string;
    is_cumulative?: boolean;
    operation_weights?: Record<string, number>;
    time_windows?: any[];
}

interface CrudConfig {
    create?: number;
    read?: number;
    update?: number;
    delete?: number;
}

interface NerfConfig {
    enabled: boolean;
    start_delay_seconds: number;
    mode: 'speed' | 'quota';
    speed_pct?: number; // Nova: % de cota mantida no nerf (default 10)
    stop_after_seconds: number; // -1 for never stop
}

interface KeyGroupData {
    id: string;
    name: string;
    rate_limit: number;
    burst_limit: number;
    window_seconds: number;
    crud_limits?: CrudConfig;
    rejection_message?: string;
    nerf_config?: NerfConfig;
    scopes: string[];
    is_cumulative_default?: boolean;
}

interface ApiKeyData {
    id: string;
    group_id?: string;
    rate_limit?: number;
    burst_limit?: number;
    scopes?: string[];
    expires_at?: string;
    is_nerfed?: boolean; // Runtime flag
    is_cumulative_default?: boolean; // Inherited from group
}

interface RateCheckResult {
    blocked: boolean;
    limit?: number;
    remaining?: number;
    retryAfter?: number;
    customMessage?: string;
}

export interface AuthSecurityConfig {
    max_attempts: number;
    lockout_minutes: number;
    strategy: 'ip' | 'identifier' | 'hybrid' | 'email';
    disabled?: boolean;
}

export class RateLimitService {
    private static dragonfly: DragonflyClient | null = null;
    private static dragonflySub: DragonflyClient | null = null; // Instância dedicada para PUB/SUB
    private static rulesCache = new Map<string, RateLimitRule[]>();

    // L1 Cache (O "Segredo" do Zero-Network Hot-Path)
    // Usamos um LRU na memória V8 sincronamente. Muito mais rápido que ir no Dragonfly.
    private static l1ProjectCache = new LRUCache<string, any>({
        max: 500, // Máximo de 500 Tenants mantidos ativamente em cache local
        ttl: 1000 * 60 * 60 * 2, // Fica vivo por 2 horas, a menos que o Pub/Sub invalide
        updateAgeOnGet: true
    });

    // L1 Cache para Multiplicador Adaptativo (CPU) e IP Blocklist (Zero-Network)
    private static adaptiveMultiplier = 1.0;
    private static lastMultiplierCheck = 0;
    private static isAdaptiveEnabled = true; // Global master switch
    private static ipBlocklist = new Set<string>();
    private static lastBlocklistSync = 0;

    private static keysCache = new Map<string, { data: ApiKeyData, cachedAt: number }>();
    private static groupsCache = new Map<string, { data: KeyGroupData, cachedAt: number }>();
    private static CACHE_TTL = 60 * 1000;

    private static isDragonflyHealthy = false;

    public static init() {
        try {
            const dragonflyOpts = {
                host: process.env.DRAGONFLY_HOST || 'dragonfly',
                port: parseInt(process.env.DRAGONFLY_PORT || '6379'),
                maxRetriesPerRequest: 1,
                retryStrategy: (times: number) => Math.min(times * 200, 5000),
                enableOfflineQueue: false,
                lazyConnect: true
            };

            this.dragonfly = new DragonflyClient(dragonflyOpts);
            this.dragonflySub = new DragonflyClient(dragonflyOpts);

            // Dragonfly principal (Comandos)
            this.dragonfly.connect().catch((e: any) => console.warn("[RateLimit] Initial Dragonfly connect failed:", e.message));
            this.dragonfly.on('error', (err: any) => { this.isDragonflyHealthy = false; });
            this.dragonfly.on('connect', () => {
                console.log('[RateLimit] Dragonfly Connected & Healthy.');
                this.isDragonflyHealthy = true;
            });

            // Dragonfly Sub (Escutando Invalidações Globais)
            this.dragonflySub.connect().then(() => {
                this.dragonflySub?.subscribe('sys:cache:invalidate', (err: any, count: any) => {
                    if (err) console.error("Failed to subscribe to invalidation channel", err);
                });

                // DRAGONFLY SEMANTIC CACHE (Fase 1.3)
                this.dragonflySub?.subscribe('cascata_cache_invalidate', (err: any, count: any) => {
                    if (err) console.error("Failed to subscribe to semantic cache invalidation", err);
                });
            }).catch(() => { });

            this.dragonflySub.on('message', async (channel: string, message: string) => {
                if (channel === 'sys:cache:invalidate') {
                    if (message.startsWith('slug:')) {
                        this.l1ProjectCache.delete(message);
                    } else if (message.startsWith('domain:')) {
                        this.l1ProjectCache.delete(message);
                    } else {
                        this.l1ProjectCache.delete(`slug:${message}`);
                        this.l1ProjectCache.delete(`domain:${message}`);
                    }
                }
                if (channel === 'cascata_cache_invalidate') {
                    try {
                        const payload = JSON.parse(message);
                        if (payload.table && this.dragonfly && this.isDragonflyHealthy) {
                            const keys = await this.dragonfly.keys(`qcache:${payload.table}:*`);
                            if (keys.length > 0) await this.dragonfly.del(...keys);
                        }
                    } catch (err) {}
                }
            });

            // Initial sync
            this.refreshGlobalSettings().catch(() => {});
        } catch (e) {
            console.error("[RateLimit] Fatal Dragonfly Init Error:", e);
            this.dragonfly = null;
            this.dragonflySub = null;
        }
    }

    public static invalidateGroup(groupId: string) {
        this.groupsCache.delete(groupId);
    }

    // --- STORAGE QUOTA CACHING & LOCKING ---

    public static async reserveStorage(projectSlug: string, bytes: number, ttlSeconds: number = 3600) {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const key = `storage:reserved:${projectSlug}`;
            const reservationId = crypto.randomUUID();
            const itemKey = `${key}:${reservationId}`;

            const pipe = this.dragonfly.multi();
            pipe.set(itemKey, bytes, 'EX', ttlSeconds);
            await pipe.exec();

            return reservationId;
        } catch (e) { console.error("[StorageLock] Reserve failed", e); return null; }
    }

    public static async releaseStorage(projectSlug: string, reservationId: string) {
        if (!this.dragonfly || !this.isDragonflyHealthy || !reservationId) return;
        try {
            const itemKey = `storage:reserved:${projectSlug}:${reservationId}`;
            await this.dragonfly.del(itemKey);
        } catch (e) { console.error("[StorageLock] Release failed", e); }
    }

    public static async getReservedStorage(projectSlug: string): Promise<number> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return 0;
        try {
            const keys = await this.dragonfly.keys(`storage:reserved:${projectSlug}:*`);
            if (keys.length === 0) return 0;

            const values = await this.dragonfly.mget(keys);
            return values.reduce((acc: number, val: string | null) => acc + (parseInt(val || '0') || 0), 0);
        } catch (e) { return 0; }
    }

    // NEW: Caching methods for Storage Quota Optimization
    public static async getProjectStorageUsage(projectSlug: string): Promise<number | null> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return null;
        try {
            const val = await this.dragonfly.get(`storage:usage:${projectSlug}`);
            return val ? parseInt(val) : null;
        } catch (e) { return null; }
    }

    public static async setProjectStorageUsage(projectSlug: string, bytes: number, ttlSeconds: number = 3600) {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            await this.dragonfly.set(`storage:usage:${projectSlug}`, bytes, 'EX', ttlSeconds);
        } catch (e) { }
    }

    public static async invalidateProjectStorageUsage(projectSlug: string) {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            await this.dragonfly.del(`storage:usage:${projectSlug}`);
        } catch (e) { }
    }

    public static async refreshGlobalSettings() {
        try {
            const dbRes = await systemPool.query(
                "SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'system_config'"
            );
            if (dbRes.rows[0]?.settings) {
                const settings = dbRes.rows[0].settings;
                this.isAdaptiveEnabled = settings.adaptive_nerf_enabled !== false; 
                console.log(`[RateLimit] Global Settings Refreshed. Adaptive Enabled: ${this.isAdaptiveEnabled}`);
            }
        } catch (e) {
            console.warn("[RateLimit] Failed to refresh global settings, using defaults.");
        }
    }

    // --- PROJECT CACHING (System Protection & L1 Sync Acceleration) ---
    public static getCachedProjectSync(identifier: string, type: 'slug' | 'domain'): any | null {
        // Leitura SÍNCRONA, bloqueante de 0ms diretamente da RAM V8
        const key = `${type}:${identifier}`;
        return this.l1ProjectCache.get(key) || null;
    }

    public static async getCachedProjectL2(identifier: string, type: 'slug' | 'domain'): Promise<any | null> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return null;
        try {
            const l2Key = `sys:project:${type}:${identifier}`;
            const data = await this.dragonfly.get(l2Key);
            if (data) {
                const parsed = JSON.parse(data);
                // Se achou no L2 (Dragonfly), retro-alimenta o L1 (V8 Heap)
                this.l1ProjectCache.set(`${type}:${identifier}`, parsed);
                return parsed;
            }
            return null;
        } catch (e) { return null; }
    }

    public static async cacheProject(project: any) {
        // Salva síncronamente no L1 local
        this.l1ProjectCache.set(`slug:${project.slug}`, project);
        if (project.custom_domain) {
            this.l1ProjectCache.set(`domain:${project.custom_domain}`, project);
        }

        // Salva assíncronamente no L2 (Dragonfly) pra outros workers
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            await this.dragonfly.set(`sys:project:slug:${project.slug}`, JSON.stringify(project), 'EX', 60 * 60 * 24); // 24h L2 Cache TTL
            if (project.custom_domain) {
                await this.dragonfly.set(`sys:project:domain:${project.custom_domain}`, JSON.stringify(project), 'EX', 60 * 60 * 24);
            }
        } catch (e) { }
    }

    public static async warmupProjectContext(req: any) {
        // Tenta inferir de qual tenant é essa request
        let slugResolver = null;
        let domainResolver = null;

        const host = req.headers.host?.split(':')[0] || '';

        if (req.url.startsWith('/api/data/')) {
            const parts = req.url.split('/');
            if (parts.length >= 4) slugResolver = parts[3];
        } else if (host && host !== 'localhost' && host !== '127.0.0.1' && !host.includes('cascata-api')) {
            domainResolver = host;
        }

        if (!slugResolver && !domainResolver) return;

        // Fase 1: Zero-Network (Ram Síncrona, 0 microsegundos de atraso I/O)
        const l1Hit = slugResolver
            ? this.getCachedProjectSync(slugResolver, 'slug')
            : this.getCachedProjectSync(domainResolver!, 'domain');

        if (l1Hit) {
            req.project = l1Hit;
            return;
        }

        // Fase 2: Low-Network (Dragonfly, ~0.2ms de atraso I/O)
        const l2Hit = slugResolver
            ? await this.getCachedProjectL2(slugResolver, 'slug')
            : await this.getCachedProjectL2(domainResolver!, 'domain');

        if (l2Hit) {
            req.project = l2Hit;
            return;
        }

        // Fase 3: High-I/O Penalty (Fallback pro Banco de Dados, custa conexão e trava Node)
        try {
            const sysSecret = process.env.SYSTEM_JWT_SECRET || '';
            const query = slugResolver
                ? `SELECT id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, metadata, status,
                          pgp_sym_decrypt(jwt_secret::bytea, $1::text) as jwt_secret,
                          pgp_sym_decrypt(anon_key::bytea, $1::text) as anon_key,
                          pgp_sym_decrypt(service_key::bytea, $1::text) as service_key
                   FROM system.projects WHERE slug = $2`
                : `SELECT id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, metadata, status,
                          pgp_sym_decrypt(jwt_secret::bytea, $1::text) as jwt_secret,
                          pgp_sym_decrypt(anon_key::bytea, $1::text) as anon_key,
                          pgp_sym_decrypt(service_key::bytea, $1::text) as service_key
                   FROM system.projects WHERE custom_domain = $2`;
            const val = slugResolver ? slugResolver : domainResolver;

            const res = await systemPool.query(query, [sysSecret, val]);
            if (res.rows.length > 0) {
                let projectConfig = {};
                try {
                    const confRes = await systemPool.query("SELECT * FROM system.project_configs WHERE project_id = $1", [res.rows[0].id]);
                    projectConfig = confRes.rows[0] || {};
                } catch (configErr) {
                    // system.project_configs pode não existir ainda — fallback seguro a {}
                }
                const project = { ...res.rows[0], config: projectConfig };

                // Popula o cache para NUNCA MAIS ter que esperar o Banco
                await this.cacheProject(project);
                req.project = project;
            }
        } catch (e) {
            console.error(`[Warmup] Falha grave ao resolver ${slugResolver || domainResolver}:`, e);
        }
    }

    public static async isTokenBlacklisted(token: string): Promise<boolean> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return false;
        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            return (await this.dragonfly.exists(`blacklist:jwt:${tokenHash}`)) === 1;
        } catch (e) { return false; }
    }

    public static async blacklistToken(token: string, ttlSeconds: number): Promise<void> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const key = `blacklist:jwt:${tokenHash}`;
            await this.dragonfly.set(key, 'revoked', 'EX', ttlSeconds);
        } catch (e) { console.error("[TokenSecurity] Failed to blacklist:", e); }
    }

    public static clearRules(projectSlug: string) {
        this.rulesCache.delete(projectSlug);
    }

    public static async trackGlobalRPS(slug: string) {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const key = `rps:${slug}`;
            const pipe = this.dragonfly.multi();
            pipe.incr(key);
            pipe.expire(key, 2);
            await pipe.exec();
        } catch (e) { }
    }

    public static async getCurrentRPS(slug: string): Promise<number> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return 0;
        try {
            const count = await this.dragonfly.get(`rps:${slug}`);
            return parseInt(count || '0');
        } catch (e) { return 0; }
    }

    public static async checkPanic(slug: string): Promise<boolean> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return false;
        try { return (await this.dragonfly.get(`panic:${slug}`)) === 'true'; } catch (e) { return false; }
    }

    public static async setPanic(slug: string, state: boolean): Promise<void> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            if (state) await this.dragonfly.set(`panic:${slug}`, 'true');
            else await this.dragonfly.del(`panic:${slug}`);
        } catch (e) { }
    }

    // --- ADAPTIVE RATE LIMITING & EDGE DEFENSE ---

    public static async getAdaptiveMultiplier(): Promise<number> {
        // L1 Cache: Só consulta Dragonfly/OS a cada 2 segundos
        if (Date.now() - this.lastMultiplierCheck < 2000) return this.adaptiveMultiplier;
        this.lastMultiplierCheck = Date.now();

        if (!this.dragonfly || !this.isDragonflyHealthy) return 1.0;

        try {
            const loadStr = await this.dragonfly.get('sys:health:cpu_load');
            const load = parseFloat(loadStr || '0');

            if (!this.isAdaptiveEnabled) {
                this.adaptiveMultiplier = 1.0;
                return 1.0;
            }

            if (load > 90) {
                // Se a carga estiver extrema (>90%), reduzimos todas as cotas do servidor em 50%
                this.adaptiveMultiplier = 0.5;
            } else if (load > 75) {
                // Carga alta (>75%): Redução de 20% proativa
                this.adaptiveMultiplier = 0.8;
            } else {
                this.adaptiveMultiplier = 1.0;
            }

            return this.adaptiveMultiplier;
        } catch (e) { return 1.0; }
    }

    public static async isIpBlocked(ip: string): Promise<boolean> {
        // L1 Blocklist Sync (Local V8 RAM) - Sync a cada 10 segundos
        if (Date.now() - this.lastBlocklistSync > 10000) {
            this.syncBlocklist().catch(() => {});
        }
        return this.ipBlocklist.has(ip);
    }

    private static async syncBlocklist() {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const list = await this.dragonfly.smembers('sys:firewall:blocklist');
            this.ipBlocklist = new Set(list);
            this.lastBlocklistSync = Date.now();
        } catch (e) {}
    }

    public static async registerStrike(ip: string, reason: string = 'abuse') {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const key = `abuser:strikes:${ip}`;
            const strikes = await this.dragonfly.incr(key);
            if (strikes === 1) await this.dragonfly.expire(key, 3600); // 1h windows for strikes

            if (strikes >= 10) { // 10 strikes em 1h = Banimento Automático
                await this.dragonfly.sadd('sys:firewall:blocklist', ip);
                // Opcional: TTL pro banimento (ex: 24h)
                // Usamos sets para facilitar a exportação pro iptables/ipset
                this.ipBlocklist.add(ip);
                console.warn(`[EdgeDefense] IP ${ip} blocked due to ${reason}. Recent strikes: ${strikes}`);
            }
        } catch (e) {}
    }

    // --- DATA FETCHING ---
    private static async getGroupData(groupId: string, systemPool: Pool): Promise<KeyGroupData | null> {
        const memCached = this.groupsCache.get(groupId);
        if (memCached && (Date.now() - memCached.cachedAt < this.CACHE_TTL)) return memCached.data;

        try {
            const res = await systemPool.query(
                `SELECT id, name, rate_limit, burst_limit, window_seconds, crud_limits, scopes, rejection_message, nerf_config, is_cumulative_default 
                 FROM system.api_key_groups WHERE id = $1`,
                [groupId]
            );
            if (res.rows.length > 0) {
                const data = res.rows[0];
                this.groupsCache.set(groupId, { data, cachedAt: Date.now() });
                return data;
            }
        } catch (e) { console.error("Error fetching group data", e); }
        return null;
    }

    private static async validateCustomKey(apiKey: string, projectSlug: string, systemPool: Pool): Promise<ApiKeyData | null> {
        const memCached = this.keysCache.get(apiKey);
        if (memCached && (Date.now() - memCached.cachedAt < 30000)) return memCached.data;

        try {
            let row: any = null;
            const parts = apiKey.split('_');
            if (parts.length === 4) {
                const lookupIndex = `${parts[0]}_${parts[1]}_${parts[2]}`;

                const res = await systemPool.query(
                    `SELECT id, group_id, rate_limit, burst_limit, scopes, expires_at, key_hash
                     FROM system.api_keys 
                     WHERE project_slug = $1 AND lookup_index = $2 AND is_active = true`,
                    [projectSlug, lookupIndex]
                );

                if (res.rows.length > 0) {
                    const candidate = res.rows[0];
                    const match = await bcrypt.compare(apiKey, candidate.key_hash);
                    if (match) row = candidate;
                }
            }

            if (row) {
                const keyData: ApiKeyData = {
                    id: row.id,
                    group_id: row.group_id,
                    rate_limit: row.rate_limit,
                    burst_limit: row.burst_limit,
                    scopes: row.scopes,
                    expires_at: row.expires_at
                };

                let isNerfed = false;

                if (keyData.expires_at) {
                    const now = new Date();
                    const expiry = new Date(keyData.expires_at);

                    if (now > expiry) {
                        if (keyData.group_id) {
                            const group = await this.getGroupData(keyData.group_id, systemPool);
                            if (group) {
                                keyData.is_cumulative_default = group.is_cumulative_default;
                                if (group.nerf_config?.enabled) {
                                    const secondsSinceExpiry = (now.getTime() - expiry.getTime()) / 1000;
                                    if (secondsSinceExpiry < (group.nerf_config.start_delay_seconds || 0)) {
                                        // Grace period
                                    } else {
                                        if (group.nerf_config.stop_after_seconds > -1 && secondsSinceExpiry > (group.nerf_config.start_delay_seconds + group.nerf_config.stop_after_seconds)) {
                                            return null; // Dead
                                        }
                                        isNerfed = true;
                                    }
                                }
                            } else {
                                return null;
                            }
                        } else {
                            return null;
                        }
                    } else if (keyData.group_id) {
                        // Even if not expired, we need to load group defaults like rollover
                        const group = await this.getGroupData(keyData.group_id, systemPool);
                        if (group) keyData.is_cumulative_default = group.is_cumulative_default;
                    }
                }

                const finalData = { ...keyData, is_nerfed: isNerfed };
                this.keysCache.set(apiKey, { data: finalData, cachedAt: Date.now() });
                systemPool.query('UPDATE system.api_keys SET last_used_at = NOW() WHERE id = $1', [keyData.id]).catch(() => { });
                return finalData;
            }
        } catch (e) { }
        return null;
    }

    private static async loadRules(projectSlug: string, systemPool: Pool) {
        try {
            const res = await systemPool.query(`SELECT * FROM system.rate_limits WHERE project_slug = $1`, [projectSlug]);
            const rules = res.rows || [];

            // Specificity-based Sorting: Exact > Prefix > Global
            rules.sort((a: any, b: any) => {
                const patA = a.route_pattern || '';
                const patB = b.route_pattern || '';

                if (patA === patB) return 0;
                if (patA === '*') return 1;
                if (patB === '*') return -1;

                const isPrefixA = patA.endsWith('*');
                const isPrefixB = patB.endsWith('*');

                if (!isPrefixA && isPrefixB) return -1;
                if (isPrefixA && !isPrefixB) return 1;

                if (isPrefixA && isPrefixB) {
                    // Longer prefix is more specific
                    return patB.length - patA.length;
                }

                return 0; // Both exact
            });

            this.rulesCache.set(projectSlug, rules);
        } catch (e) { this.rulesCache.set(projectSlug, []); }
    }

    public static async check(
        projectSlug: string,
        logicalResource: string,
        method: string,
        userRole: string,
        ip: string,
        systemPool: Pool,
        authToken?: string
    ): Promise<RateCheckResult> {
        if (!this.dragonfly || !this.isDragonflyHealthy) return { blocked: false };

        // 0. Edge Defense: IP Blocklist Check (Fast Path)
        if (await this.isIpBlocked(ip)) {
            return { blocked: true, retryAfter: 3600, customMessage: 'Firewall: Your IP is blacklisted for abuse.' };
        }

        // 0.1 Adaptive Multiplier (CPU Backpressure)
        const adaptiveMult = await this.getAdaptiveMultiplier();

        let subject = ip;
        let ruleId = 'default';
        let limit = 50;
        let burst = 50;
        let windowSecs = 1;
        let crudConfig: CrudConfig | undefined = undefined;
        let tier: 'anon' | 'auth' | 'custom_key' = 'anon';
        let keyGroupId: string | null = null;
        let keyCustomMessage: string | undefined = undefined;

        if (authToken && authToken.startsWith('sk_')) {
            const keyData = await this.validateCustomKey(authToken, projectSlug, systemPool);
            if (keyData) {
                tier = 'custom_key';
                subject = keyData.id;
                keyGroupId = keyData.group_id || null;

                if (keyData.group_id) {
                    const gData = await this.getGroupData(keyData.group_id, systemPool);
                    if (gData) {
                        limit = gData.rate_limit;
                        burst = gData.burst_limit;
                        windowSecs = gData.window_seconds || 1;
                        crudConfig = gData.crud_limits;
                        keyCustomMessage = gData.rejection_message;

                        if (keyData.is_nerfed) {
                            const speedPct = gData.nerf_config?.speed_pct ?? 10;
                            limit = Math.max(1, Math.floor(limit * (speedPct / 100)));
                            burst = 0;
                        }
                    }
                }
                if (keyData.rate_limit && !keyData.is_nerfed) limit = keyData.rate_limit;
                if (keyData.burst_limit && !keyData.is_nerfed) burst = keyData.burst_limit;
            }
        } else if (userRole === 'authenticated' && authToken) {
            tier = 'auth';
            try {
                const decoded: any = jwt.decode(authToken);
                if (decoded && decoded.sub) subject = decoded.sub;
            } catch (e) { }
        }

        if (!this.rulesCache.has(projectSlug)) {
            await this.loadRules(projectSlug, systemPool);
        }
        const rules = this.rulesCache.get(projectSlug) || [];
        const matchedRule = rules.find((r) => {
            const methodMatch = r.method === 'ALL' || r.method === method;
            if (r.route_pattern === logicalResource) return methodMatch;
            if (r.route_pattern.endsWith('*')) {
                const prefix = r.route_pattern.slice(0, -1);
                if (logicalResource.startsWith(prefix)) return methodMatch;
            }
            if (r.route_pattern === '*') return methodMatch;
            return false;
        });

        let isCumulative = false;
        if (matchedRule) {
            ruleId = matchedRule.id;
            if (matchedRule.window_seconds) windowSecs = matchedRule.window_seconds;
            isCumulative = matchedRule.is_cumulative || false;

            if (tier === 'custom_key' && keyGroupId && matchedRule.group_limits && matchedRule.group_limits[keyGroupId]) {
                const gLimit = matchedRule.group_limits[keyGroupId];
                let ruleRate = gLimit.rate;
                let ruleBurst = gLimit.burst;
                const memCached = this.keysCache.get(authToken || '');
                if (memCached?.data.is_nerfed) {
                    const groupData = keyGroupId ? await this.getGroupData(keyGroupId, systemPool) : null;
                    const speedPct = groupData?.nerf_config?.speed_pct ?? 10;
                    ruleRate = Math.max(1, Math.floor(ruleRate * (speedPct / 100)));
                    ruleBurst = 0;
                }
                limit = ruleRate;
                burst = ruleBurst;
                crudConfig = gLimit.crud;
                // If not explicitly set in rule, use group default
                if (matchedRule.is_cumulative === undefined) {
                    isCumulative = memCached?.data.is_cumulative_default || false;
                }
            } else if (tier === 'auth') {
                limit = matchedRule.rate_limit_auth ?? (matchedRule.rate_limit * 2);
                burst = matchedRule.burst_limit_auth ?? (matchedRule.burst_limit * 2);
                crudConfig = matchedRule.crud_limits?.auth;
            } else if (tier === 'anon') {
                limit = matchedRule.rate_limit_anon ?? matchedRule.rate_limit;
                burst = matchedRule.burst_limit_anon ?? matchedRule.burst_limit;
                crudConfig = matchedRule.crud_limits?.anon;
            }
        }

        let operation: keyof CrudConfig | null = null;
        if (method === 'GET') operation = 'read';
        else if (method === 'POST') operation = 'create';
        else if (method === 'PATCH' || method === 'PUT') operation = 'update';
        else if (method === 'DELETE') operation = 'delete';

        if (operation && crudConfig && crudConfig[operation] !== undefined && crudConfig[operation] !== null) {
            const specificLimit = crudConfig[operation]!;
            if (specificLimit === -1) return { blocked: false };

            const memCached = authToken ? this.keysCache.get(authToken) : null;
            if (memCached?.data.is_nerfed) {
                const groupData = keyGroupId ? await this.getGroupData(keyGroupId, systemPool) : null;
                const speedPct = groupData?.nerf_config?.speed_pct ?? 10;
                limit = Math.max(1, Math.floor(specificLimit * (speedPct / 100)));
                burst = 0;
            } else {
                limit = specificLimit;
                burst = Math.ceil(limit / 2);
            }
            ruleId = `${ruleId}:${operation}`;
        }

        // --- NEW: Operation Weights Logic ---
        // Weights are applied to the increment value (cost of the request)
        let weight = 1;
        if (operation && matchedRule) {
            // Check if there are specific weights for this operation in the rule or group
            const weights: Record<string, number> = matchedRule.operation_weights || {
                read: 1, create: 5, update: 2, delete: 3
            };
            weight = weights[operation] || 1;
        }

        // --- PRE-VALIDATION (Dry-run) ---
        const windows = matchedRule?.time_windows || [{ type: 'default', window_seconds: windowSecs, limit, burst }];
        const winResults: Array<{ key: string, limit: number, burst: number, secs: number, type: string, useQuota: boolean }> = [];
        
        for (const win of windows) {
            const winSecs = win.window_seconds || windowSecs;
            const winLimit = Math.floor((win.limit || limit) * adaptiveMult);
            const winBurst = Math.floor((win.burst || burst) * adaptiveMult);
            const winKey = `rate:${projectSlug}:${tier}:${subject}:${ruleId}:${win.type || 'default'}`;
            const winType = win.type || 'default';

            const memCached = authToken ? this.keysCache.get(authToken) : null;
            const keyIsNerfed = memCached?.data.is_nerfed || false;

            let useQuota = false;
            // Atomic Sinergy: Only allow quota bypass if NOT nerfed. Balance should not bypass punishment.
            if (isCumulative && !keyIsNerfed && (tier === 'auth' || tier === 'custom_key') && subject !== 'anonymous') {
                const balance = await RateLimitService.getQuotaBalance(projectSlug, tier, subject, ruleId, winType, systemPool);
                if (balance >= weight) {
                    useQuota = true;
                }
            }

            if (!useQuota) {
                // Standard limit check (Dry-run)
                const currentStr = await this.dragonfly.get(winKey);
                const currentCount = currentStr ? parseInt(currentStr) : 0;
                const totalAllowed = winLimit + winBurst;

                if (currentCount + weight > totalAllowed) {
                    let customMessage = matchedRule?.message_auth || 'Rate limit exceeded';
                    if (tier === 'anon' && matchedRule?.message_anon) customMessage = matchedRule.message_anon;

                    if (winType === 'default' || winType === 'standard') {
                        await this.registerStrike(ip, 'exceeding default rate limits');
                    }

                    const ttl = await this.dragonfly.ttl(winKey);
                    return {
                        blocked: true,
                        limit: winLimit,
                        remaining: 0,
                        retryAfter: ttl > 0 ? ttl : winSecs,
                        customMessage: `${customMessage} (${winType} limit)`
                    };
                }
            }

            winResults.push({ key: winKey, limit: winLimit, burst: winBurst, secs: winSecs, type: winType, useQuota });
        }

        // --- COMMITMENT PHASE (Sinergy) ---
        // If we reached here, ALL windows are allowed. Now we commit the changes.
        for (const res of winResults) {
            if (res.useQuota) {
                // Fair Billing: Only deduct now that we know the entire request is valid
                await RateLimitService.updateQuotaBalance(projectSlug, tier, subject, ruleId, res.type, -weight, systemPool);
            } else {
                const pipeline = this.dragonfly.multi();
                pipeline.incrby(res.key, weight);
                pipeline.ttl(res.key);
                const results = await pipeline.exec();
                if (results && results[1][1] === -1) {
                    await this.dragonfly.expire(res.key, res.secs);
                }
            }
        }

        return { blocked: false, limit, remaining: 1 };
    }

    private static async getQuotaBalance(projectSlug: string, tier: string, subjectId: string, ruleId: string, windowType: string, pool: any): Promise<number> {
        try {
            const res = await pool.query(
                `SELECT balance FROM system.quota_balances 
                 WHERE project_slug = $1 AND tier = $2 AND subject_id = $3 AND resource_id = $4 AND window_type = $5`,
                [projectSlug, tier, subjectId, ruleId, windowType]
            );
            return res.rows.length > 0 ? parseInt(res.rows[0].balance) : 0;
        } catch (e) { return 0; }
    }

    private static async updateQuotaBalance(projectSlug: string, tier: string, subjectId: string, ruleId: string, windowType: string, delta: number, pool: any) {
        try {
            await pool.query(
                `INSERT INTO system.quota_balances (project_slug, tier, subject_id, resource_id, window_type, balance, last_reset)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (project_slug, tier, subject_id, resource_id, window_type)
                 DO UPDATE SET balance = system.quota_balances.balance + $6, last_reset = NOW()`,
                [projectSlug, tier, subjectId, ruleId, windowType, delta]
            );
        } catch (e) { console.error("[Rollover] Failed to update balance", e); }
    }

    public static async checkAuthLockout(slug: string, ip: string, identifier?: string, config?: AuthSecurityConfig): Promise<{ locked: boolean, reason?: string }> {
        if (!this.dragonfly || !this.isDragonflyHealthy || !config || config.disabled) return { locked: false };

        const strategy = config.strategy || 'hybrid';
        const maxAttempts = config.max_attempts || 5;

        try {
            // 1. IP-Level Global Strike Check (Heuristic: 3x the max attempts means someone is spraying this IP)
            if (strategy === 'hybrid' || strategy === 'ip') {
                const ipKey = `lockout:ip:${slug}:${ip}`;
                const ipStrikes = parseInt(await this.dragonfly.get(ipKey) || '0');
                if (ipStrikes >= (maxAttempts * 3)) {
                    return { locked: true, reason: `Too many failed attempts from your network. Locked for ${config.lockout_minutes || 15} minutes.` };
                }
            }

            // 2. Identifier-Level Check (email, username, phone, etc)
            if (identifier && (strategy === 'hybrid' || strategy === 'identifier' || strategy === 'email')) {
                const idKey = `lockout:id:${slug}:${identifier}`;
                const idStrikes = parseInt(await this.dragonfly.get(idKey) || '0');
                if (idStrikes >= maxAttempts) {
                    return { locked: true, reason: `Too many failed attempts for this account. Locked for ${config.lockout_minutes || 15} minutes.` };
                }
            }

            return { locked: false };
        } catch (e) {
            console.error("[EdgeFirewall] Dragonfly Check Error:", e);
            return { locked: false }; // Fail open if Dragonfly drops
        }
    }

    public static async registerAuthFailure(slug: string, ip: string, identifier?: string, config?: AuthSecurityConfig) {
        if (!this.dragonfly || !this.isDragonflyHealthy || !config || config.disabled) return;

        const strategy = config.strategy || 'hybrid';
        const lockoutSeconds = (config.lockout_minutes || 15) * 60;

        try {
            const pipe = this.dragonfly.multi();

            // Record IP Strike
            if (strategy === 'hybrid' || strategy === 'ip') {
                const ipKey = `lockout:ip:${slug}:${ip}`;
                pipe.incr(ipKey);
                // Only set expire if it's the first strike (or reset the window if you prefer sliding)
                // Using sliding window for security: every strike resets the lockout timer
                pipe.expire(ipKey, lockoutSeconds);
            }

            // Record Identifier Strike
            if (identifier && (strategy === 'hybrid' || strategy === 'identifier' || strategy === 'email')) {
                const idKey = `lockout:id:${slug}:${identifier}`;
                pipe.incr(idKey);
                pipe.expire(idKey, lockoutSeconds);
            }

            await pipe.exec();
        } catch (e) {
            console.error("[EdgeFirewall] Dragonfly Register Failure Error:", e);
        }
    }

    public static async clearAuthFailure(slug: string, ip: string, identifier?: string) {
        if (!this.dragonfly || !this.isDragonflyHealthy) return;
        try {
            const pipe = this.dragonfly.multi();
            pipe.del(`lockout:ip:${slug}:${ip}`);
            if (identifier) pipe.del(`lockout:id:${slug}:${identifier}`);
            await pipe.exec();
        } catch (e) { }
    }
}
