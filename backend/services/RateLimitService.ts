
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

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
}

interface ApiKeyData {
    id: string;
    group_id?: string;
    rate_limit?: number;     
    burst_limit?: number;    
    scopes?: string[];      
    expires_at?: string;
    is_nerfed?: boolean; // Runtime flag
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
    strategy: 'ip' | 'email' | 'hybrid';
}

export class RateLimitService {
    private static redis: Redis | null = null;
    private static rulesCache = new Map<string, RateLimitRule[]>();
    
    // L1 Cache
    private static keysCache = new Map<string, { data: ApiKeyData, cachedAt: number }>();
    private static groupsCache = new Map<string, { data: KeyGroupData, cachedAt: number }>();
    private static CACHE_TTL = 60 * 1000; 

    private static isRedisHealthy = false;
    
    public static init() {
        try {
            this.redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                maxRetriesPerRequest: 1,
                retryStrategy: (times) => Math.min(times * 200, 5000),
                enableOfflineQueue: false,
                lazyConnect: true 
            });
            
            this.redis.connect().catch((e: any) => console.warn("[RateLimit] Initial Redis connect failed:", e.message));
            this.redis.on('error', (err) => { this.isRedisHealthy = false; });
            this.redis.on('connect', () => { console.log('[RateLimit] Redis Connected & Healthy.'); this.isRedisHealthy = true; });
        } catch (e) {
            console.error("[RateLimit] Fatal Redis Init Error:", e);
            this.redis = null;
        }
    }

    public static invalidateGroup(groupId: string) {
        this.groupsCache.delete(groupId);
    }

    // --- STORAGE QUOTA CACHING & LOCKING ---
    
    public static async reserveStorage(projectSlug: string, bytes: number, ttlSeconds: number = 3600) {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            const key = `storage:reserved:${projectSlug}`;
            const reservationId = crypto.randomUUID();
            const itemKey = `${key}:${reservationId}`;
            
            const pipe = this.redis.multi();
            pipe.set(itemKey, bytes, 'EX', ttlSeconds);
            await pipe.exec();
            
            return reservationId;
        } catch (e) { console.error("[StorageLock] Reserve failed", e); return null; }
    }

    public static async releaseStorage(projectSlug: string, reservationId: string) {
        if (!this.redis || !this.isRedisHealthy || !reservationId) return;
        try {
            const itemKey = `storage:reserved:${projectSlug}:${reservationId}`;
            await this.redis.del(itemKey);
        } catch (e) { console.error("[StorageLock] Release failed", e); }
    }

    public static async getReservedStorage(projectSlug: string): Promise<number> {
        if (!this.redis || !this.isRedisHealthy) return 0;
        try {
            const keys = await this.redis.keys(`storage:reserved:${projectSlug}:*`);
            if (keys.length === 0) return 0;
            
            const values = await this.redis.mget(keys);
            return values.reduce((acc, val) => acc + (parseInt(val || '0') || 0), 0);
        } catch (e) { return 0; }
    }

    // NEW: Caching methods for Storage Quota Optimization
    public static async getProjectStorageUsage(projectSlug: string): Promise<number | null> {
        if (!this.redis || !this.isRedisHealthy) return null;
        try {
            const val = await this.redis.get(`storage:usage:${projectSlug}`);
            return val ? parseInt(val) : null;
        } catch(e) { return null; }
    }

    public static async setProjectStorageUsage(projectSlug: string, bytes: number, ttlSeconds: number = 3600) {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            await this.redis.set(`storage:usage:${projectSlug}`, bytes, 'EX', ttlSeconds);
        } catch(e) {}
    }

    public static async invalidateProjectStorageUsage(projectSlug: string) {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            await this.redis.del(`storage:usage:${projectSlug}`);
        } catch(e) {}
    }

    // --- PROJECT CACHING (System Protection) ---
    public static async getCachedProject(identifier: string, type: 'slug' | 'domain'): Promise<any | null> {
        if (!this.redis || !this.isRedisHealthy) return null;
        try {
            const key = `sys:project:${type}:${identifier}`;
            const data = await this.redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    }

    public static async cacheProject(project: any) {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            await this.redis.set(`sys:project:slug:${project.slug}`, JSON.stringify(project), 'EX', 60); 
            if (project.custom_domain) {
                await this.redis.set(`sys:project:domain:${project.custom_domain}`, JSON.stringify(project), 'EX', 60);
            }
        } catch (e) { }
    }

    public static async isTokenBlacklisted(token: string): Promise<boolean> {
        if (!this.redis || !this.isRedisHealthy) return false;
        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            return (await this.redis.exists(`blacklist:jwt:${tokenHash}`)) === 1;
        } catch (e) { return false; }
    }
    
    public static async blacklistToken(token: string, ttlSeconds: number): Promise<void> {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const key = `blacklist:jwt:${tokenHash}`;
            await this.redis.set(key, 'revoked', 'EX', ttlSeconds);
        } catch (e) { console.error("[TokenSecurity] Failed to blacklist:", e); }
    }

    public static clearRules(projectSlug: string) {
        this.rulesCache.delete(projectSlug);
    }

    public static async trackGlobalRPS(slug: string) {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            const key = `rps:${slug}`;
            const pipe = this.redis.multi();
            pipe.incr(key);
            pipe.expire(key, 2);
            await pipe.exec();
        } catch (e) { }
    }

    public static async getCurrentRPS(slug: string): Promise<number> {
        if (!this.redis || !this.isRedisHealthy) return 0;
        try {
            const count = await this.redis.get(`rps:${slug}`);
            return parseInt(count || '0');
        } catch (e) { return 0; }
    }

    public static async checkPanic(slug: string): Promise<boolean> {
        if (!this.redis || !this.isRedisHealthy) return false; 
        try { return (await this.redis.get(`panic:${slug}`)) === 'true'; } catch (e) { return false; }
    }

    public static async setPanic(slug: string, state: boolean): Promise<void> {
        if (!this.redis || !this.isRedisHealthy) return;
        try {
            if (state) await this.redis.set(`panic:${slug}`, 'true');
            else await this.redis.del(`panic:${slug}`);
        } catch (e) {}
    }

    // --- DATA FETCHING ---
    private static async getGroupData(groupId: string, systemPool: Pool): Promise<KeyGroupData | null> {
        const memCached = this.groupsCache.get(groupId);
        if (memCached && (Date.now() - memCached.cachedAt < this.CACHE_TTL)) return memCached.data;

        try {
            const res = await systemPool.query(
                `SELECT id, name, rate_limit, burst_limit, window_seconds, crud_limits, scopes, rejection_message, nerf_config 
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
                            if (group && group.nerf_config?.enabled) {
                                const secondsSinceExpiry = (now.getTime() - expiry.getTime()) / 1000;
                                
                                if (secondsSinceExpiry < (group.nerf_config.start_delay_seconds || 0)) {
                                     // Grace period
                                } else {
                                    if (group.nerf_config.stop_after_seconds > -1 && secondsSinceExpiry > (group.nerf_config.start_delay_seconds + group.nerf_config.stop_after_seconds)) {
                                        return null; // Dead
                                    }
                                    isNerfed = true;
                                }
                            } else {
                                return null; 
                            }
                        } else {
                            return null;
                        }
                    }
                }
                
                const finalData = { ...keyData, is_nerfed: isNerfed };
                this.keysCache.set(apiKey, { data: finalData, cachedAt: Date.now() });
                systemPool.query('UPDATE system.api_keys SET last_used_at = NOW() WHERE id = $1', [keyData.id]).catch(() => {});
                return finalData;
            }
        } catch (e) { }
        return null;
    }

    private static async loadRules(projectSlug: string, systemPool: Pool) {
        try {
            const res = await systemPool.query(`SELECT * FROM system.rate_limits WHERE project_slug = $1`, [projectSlug]);
            this.rulesCache.set(projectSlug, res.rows);
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
        if (!this.redis || !this.isRedisHealthy) return { blocked: false };
        
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
                             limit = Math.max(1, Math.floor(limit * 0.1));
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
            } catch (e) {}
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

        if (matchedRule) {
            ruleId = matchedRule.id;
            if (matchedRule.window_seconds) windowSecs = matchedRule.window_seconds;

            if (tier === 'custom_key' && keyGroupId && matchedRule.group_limits && matchedRule.group_limits[keyGroupId]) {
                const gLimit = matchedRule.group_limits[keyGroupId];
                let ruleRate = gLimit.rate;
                let ruleBurst = gLimit.burst;
                const memCached = this.keysCache.get(authToken || '');
                if (memCached?.data.is_nerfed) {
                    ruleRate = Math.max(1, Math.floor(ruleRate * 0.1));
                    ruleBurst = 0;
                }
                limit = ruleRate;
                burst = ruleBurst;
                crudConfig = gLimit.crud;
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
                 limit = Math.max(1, Math.floor(specificLimit * 0.1));
                 burst = 0;
            } else {
                 limit = specificLimit;
                 burst = Math.ceil(limit / 2);
            }
            ruleId = `${ruleId}:${operation}`;
        }

        const key = `rate:${projectSlug}:${tier}:${subject}:${ruleId}`;
        try {
            const pipeline = this.redis.multi();
            pipeline.incr(key);
            pipeline.ttl(key);
            const results = await pipeline.exec();

            if (!results) throw new Error("Redis failed");
            const [incrErr, incrRes] = results[0];
            const [ttlErr, ttlRes] = results[1];
            if (incrErr) throw incrErr;

            const count = incrRes as number;
            const currentTtl = ttlRes as number;

            if (currentTtl === -1) await this.redis.expire(key, windowSecs);

            const totalLimit = limit + burst;
            if (count > totalLimit) {
                let customMessage = keyCustomMessage;
                if (!customMessage && matchedRule) {
                    if (tier === 'anon') customMessage = matchedRule.message_anon;
                    if (tier === 'auth') customMessage = matchedRule.message_auth;
                }
                
                return { 
                    blocked: true, 
                    limit, 
                    remaining: 0, 
                    retryAfter: currentTtl > 0 ? currentTtl : windowSecs,
                    customMessage
                };
            }
            return { blocked: false, limit, remaining: Math.max(0, totalLimit - count) };
        } catch (e) {
            return { blocked: false };
        }
    }
    
    public static async checkAuthLockout(slug: string, ip: string, email?: string, config?: AuthSecurityConfig): Promise<{ locked: boolean, reason?: string }> { return { locked: false }; }
    public static async registerAuthFailure(slug: string, ip: string, email?: string, config?: AuthSecurityConfig) {}
    public static async clearAuthFailure(slug: string, ip: string, email?: string) {}
}
