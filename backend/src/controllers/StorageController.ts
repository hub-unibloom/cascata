
import { NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { CascataRequest } from '../types.js';
import { STORAGE_ROOT, systemPool } from '../config/main.js';
import { getSectorForExt, validateMagicBytesAsync, parseBytes } from '../utils/index.js';
import { StorageService, StorageConfig } from '../../services/StorageService.js';
import { StorageIndexer } from '../../services/StorageIndexer.js';
import { RateLimitService } from '../../services/RateLimitService.js';

export class StorageController {

    // Helper: Check Quota Usage with Logical Priority + Cache + Reservation
    private static async checkQuota(
        projectSlug: string, 
        incomingSize: number, 
        limitStr: string = '1GB', 
        provider: string = 'local'
    ): Promise<{ allowed: boolean, reservationId?: string }> {
        try {
            let currentUsage = 0;
            const limit = parseBytes(limitStr);

            // 1. Check Redis Cache (Fastest)
            const cachedUsage = await RateLimitService.getProjectStorageUsage(projectSlug);
            
            if (cachedUsage !== null) {
                currentUsage = cachedUsage;
            } else {
                // 2. Cache Miss: Use Logical Sum (DB) as Source of Truth
                const dbRes = await systemPool.query(
                    `SELECT SUM(size) as total FROM system.storage_objects WHERE project_slug = $1`,
                    [projectSlug]
                );
                let logicalSize = parseInt(dbRes.rows[0].total || '0');

                // 3. Physical Check (Optional Sanity Check for Local Provider)
                // Prevents "Zombie Files" (files on disk not in DB) from consuming infinite space.
                // If physical usage is significantly higher, we use it. Otherwise, Logical is safer/faster.
                if (provider === 'local') {
                    try {
                        const physicalSize = await StorageService.getPhysicalDiskUsage(projectSlug);
                        if (physicalSize > logicalSize) {
                            // Warn: Inconsistency detected, but trust physical to protect disk
                            logicalSize = physicalSize;
                        }
                    } catch (physErr) {
                        // If physical check fails (e.g., permission, timeout), ignore and stick to Logical.
                        console.warn(`[StorageQuota] Physical check failed for ${projectSlug}, using logical.`);
                    }
                }

                currentUsage = logicalSize;
                
                // 4. Update Cache (TTL 1h)
                await RateLimitService.setProjectStorageUsage(projectSlug, currentUsage);
            }

            // 5. Add In-Flight Reservations (Redis)
            const reserved = await RateLimitService.getReservedStorage(projectSlug);
            const totalProjected = currentUsage + reserved + incomingSize;

            if (totalProjected > limit) {
                return { allowed: false };
            }
            
            // 6. Reserve Space for this upload
            const resId = await RateLimitService.reserveStorage(projectSlug, incomingSize);
            return { allowed: true, reservationId: resId || undefined };
            
        } catch(e) {
            console.error("Quota Check Failed:", e);
            // FAIL OPEN (Safety Net) with small hard limit to prevent total outage on Redis/DB failure
            return { allowed: incomingSize < 50 * 1024 * 1024 }; 
        }
    }

    static async listBuckets(req: CascataRequest, res: any, next: any) {
        try {
            const p = path.join(STORAGE_ROOT, req.project.slug);
            await fs.mkdir(p, { recursive: true });
            
            const items = await fs.readdir(p, { withFileTypes: true });
            const buckets = items
                .filter(dirent => dirent.isDirectory())
                .map(dirent => ({ name: dirent.name }));
                
            res.json(buckets);
        } catch (e: any) {
            next(e);
        }
    }

    static async createBucket(req: CascataRequest, res: any, next: any) {
        try {
            const p = path.join(STORAGE_ROOT, req.project.slug, req.body.name);
            await fs.mkdir(p, { recursive: true });
            res.json({ success: true });
        } catch (e: any) {
            next(e);
        }
    }

    static async renameBucket(req: CascataRequest, res: any, next: any) {
        const { name } = req.params;
        const { newName } = req.body;
        
        try {
            const oldPath = path.join(STORAGE_ROOT, req.project.slug, name);
            const newPath = path.join(STORAGE_ROOT, req.project.slug, newName);
            
            try { await fs.access(oldPath); } 
            catch { return res.status(404).json({ error: 'Bucket not found' }); }

            try { await fs.access(newPath); return res.status(400).json({ error: 'Name already exists' }); } 
            catch { }
            
            await fs.rename(oldPath, newPath);
            
            try {
                await systemPool.query(
                    'UPDATE system.storage_objects SET bucket = $1 WHERE project_slug = $2 AND bucket = $3',
                    [newName, req.project.slug, name]
                );
            } catch (dbErr) {
                console.error('[StorageController] DB Update Failed. Rolling back filesystem...', dbErr);
                try {
                    await fs.rename(newPath, oldPath);
                    return res.status(500).json({ error: 'System Error: Database update failed, filesystem change reverted.' });
                } catch (rollbackErr) {
                     console.error('[StorageController] CRITICAL: Rollback failed!', rollbackErr);
                     return res.status(500).json({ error: 'Critical Error: Storage system in inconsistent state. Contact Admin.' });
                }
            }

            res.json({ success: true });
        } catch(e: any) {
            res.status(500).json({ error: 'Rename failed: ' + e.message });
        }
    }

    static async deleteBucket(req: CascataRequest, res: any, next: any) {
        try {
            const { name } = req.params;
            const projectSlug = req.project.slug;
            const bucketPath = path.join(STORAGE_ROOT, projectSlug, name);
            
            // Security Check
            if (!bucketPath.startsWith(path.join(STORAGE_ROOT, projectSlug))) { 
                return res.status(403).json({ error: 'Access denied' }); 
            }

            // 1. External Provider Cleanup
            const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };
            
            if (storageConfig.provider !== 'local') {
                const objects = await systemPool.query(
                    'SELECT full_path FROM system.storage_objects WHERE project_slug=$1 AND bucket=$2',
                    [projectSlug, name]
                );

                const deletionPromises = objects.rows.map(row => 
                    StorageService.delete(row.full_path, storageConfig)
                        .catch(err => console.warn(`[Storage] Failed to delete orphan ${row.full_path}:`, err.message))
                );

                await Promise.allSettled(deletionPromises);
            }

            // 2. Local Cleanup (Filesystem)
            await fs.rm(bucketPath, { recursive: true, force: true });
            
            // 3. Metadata Cleanup
            await systemPool.query('DELETE FROM system.storage_objects WHERE project_slug=$1 AND bucket=$2', [projectSlug, name]);
            
            // 4. Invalidate Quota Cache (Force Recalculation)
            await RateLimitService.invalidateProjectStorageUsage(projectSlug);

            res.json({ success: true }); 
        } catch (e: any) { 
            res.status(500).json({ error: e.message }); 
        }
    }

    static async createFolder(req: CascataRequest, res: any, next: any) {
        try {
            const { name, path: relativePath } = req.body;
            const bucketPath = path.join(STORAGE_ROOT, req.project.slug, req.params.bucket);
            const targetDir = path.normalize(path.join(bucketPath, relativePath || '', name));

            if (!targetDir.startsWith(bucketPath)) { 
                return res.status(403).json({ error: 'Access Denied: Path Traversal' }); 
            }
            
            try { await fs.access(targetDir); return res.status(400).json({ error: 'Folder already exists' }); } 
            catch { }

            await fs.mkdir(targetDir, { recursive: true });
            
            const fullRelPath = path.join(relativePath || '', name).replace(/\\/g, '/');
            StorageIndexer.indexObject(systemPool, req.project.slug, req.params.bucket, fullRelPath, { 
                size: 0, mimeType: 'application/directory', isFolder: true, provider: 'local' 
            });

            res.json({ success: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    }

    // --- HYBRID UPLOAD SYSTEM ---
    
    static async signUpload(req: CascataRequest, res: any, next: any) {
        let reservationId: string | undefined;
        try {
            const { name, type, size, path: targetPath } = req.body;
            const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };
            
            const limit = req.project.metadata?.storage_limit || '1GB';
            const quotaCheck = await StorageController.checkQuota(req.project.slug, size || 0, limit, storageConfig.provider);
            
            if (!quotaCheck.allowed) {
                return res.status(402).json({ error: 'Storage Quota Exceeded. Upgrade plan or delete files.' });
            }
            reservationId = quotaCheck.reservationId;

            const governance = req.project.metadata?.storage_governance || {};
            const ext = path.extname(name).replace('.', '').toLowerCase();
            const sector = getSectorForExt(ext);
            const rule = governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] };

            if (rule.allowed_exts && rule.allowed_exts.length > 0 && !rule.allowed_exts.includes(ext)) { 
                if (reservationId) await RateLimitService.releaseStorage(req.project.slug, reservationId);
                return res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` }); 
            }
            if (size && size > parseBytes(rule.max_size)) { 
                if (reservationId) await RateLimitService.releaseStorage(req.project.slug, reservationId);
                return res.status(403).json({ error: `Policy Violation: File size exceeds limit.` }); 
            }

            const bucket = req.params.bucket;
            
            let relativePath = targetPath || '';
            relativePath = relativePath.replace(new RegExp(`^${bucket}/`), '').replace(/^\/+/, ''); 
            const fullKey = path.join(relativePath, name).replace(/\\/g, '/');

            const result = await StorageService.createUploadUrl(fullKey, type, storageConfig);
            
            res.json({
                strategy: result.strategy,
                url: result.url,
                method: result.method,
                fields: result.headers, 
                proxyUrl: result.strategy === 'proxy' ? `/api/data/${req.project.slug}/storage/${bucket}/upload` : undefined
            });

        } catch (e: any) {
            if (reservationId) await RateLimitService.releaseStorage(req.project.slug, reservationId);
            res.status(500).json({ error: e.message });
        }
    }

    static async uploadFile(req: CascataRequest, res: any, next: any) {
        if (!req.file) return res.status(400).json({ error: 'No file found in request body.' });
        
        let reservationId: string | undefined;
        const cleanup = async () => { 
            try { await fs.unlink(req.file.path); } catch(e) {} 
            if (reservationId) await RateLimitService.releaseStorage(req.project.slug, reservationId);
        };

        try {
            const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };

            const limit = req.project.metadata?.storage_limit || '1GB';
            const quotaCheck = await StorageController.checkQuota(req.project.slug, req.file.size, limit, storageConfig.provider);
            
            if (!quotaCheck.allowed) {
                await cleanup();
                return res.status(402).json({ error: 'Storage Quota Exceeded. Physical limit reached.' });
            }
            reservationId = quotaCheck.reservationId;

            const governance = req.project.metadata?.storage_governance || {};
            const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
            const sector = getSectorForExt(ext);
            const rule = governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] };
            
            if (rule.allowed_exts && rule.allowed_exts.length > 0 && !rule.allowed_exts.includes(ext)) { 
                await cleanup();
                return res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` }); 
            }
            const isValidSig = await validateMagicBytesAsync(req.file.path, ext);
            if (!isValidSig) { 
                await cleanup();
                return res.status(400).json({ error: 'Security Alert: File signature mismatch.' }); 
            }
            if (req.file.size > parseBytes(rule.max_size)) { 
                await cleanup();
                return res.status(403).json({ error: `Policy Violation: File size exceeds limit.` }); 
            }

            const bucket = req.params.bucket;
            
            let relativePath = req.body.path || '';
            relativePath = relativePath.replace(new RegExp(`^${bucket}/`), '').replace(/^\/+/, ''); 

            const resultUrl = await StorageService.upload(req.file, req.project.slug, bucket, relativePath, storageConfig);

            if (storageConfig.provider === 'local') {
                const dest = path.join(STORAGE_ROOT, req.project.slug, bucket, relativePath, req.file.originalname);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fs.rename(req.file.path, dest);
                } catch (moveErr: any) {
                    if (moveErr.code === 'EXDEV') {
                        await fs.copyFile(req.file.path, dest);
                        await fs.unlink(req.file.path);
                    } else { throw moveErr; }
                }
                res.json({ success: true, path: dest.replace(STORAGE_ROOT, ''), provider: 'local' });
            } else {
                try { await fs.unlink(req.file.path); } catch(e) {}
                res.json({ success: true, path: resultUrl, provider: storageConfig.provider, url: resultUrl });
            }

            const fullKey = path.join(relativePath, req.file.originalname).replace(/\\/g, '/');
            StorageIndexer.indexObject(systemPool, req.project.slug, bucket, fullKey, {
                size: req.file.size,
                mimeType: req.file.mimetype,
                isFolder: false,
                provider: storageConfig.provider
            });
            
            // Invalidate Cache to force recount on next quota check
            await RateLimitService.invalidateProjectStorageUsage(req.project.slug);
            
            // Release reservation explicitly
            if (reservationId) await RateLimitService.releaseStorage(req.project.slug, reservationId);

        } catch (e: any) { 
            await cleanup();
            console.error("Upload Error:", e);
            res.status(500).json({ error: e.message || 'Storage Error' });
        }
    }

    static async listFiles(req: CascataRequest, res: any, next: any) {
        const { path: queryPath } = req.query;
        try {
            const items = await StorageIndexer.list(systemPool, req.project.slug, req.params.bucket, (queryPath as string) || '');
            res.json({ items });
        } catch (e: any) { 
            console.error("[Storage] List Error", e);
            res.json({ items: [] });
        }
    }

    static async search(req: CascataRequest, res: any, next: any) {
        const { q, bucket } = req.query;
        try {
            const items = await StorageIndexer.search(systemPool, req.project.slug, (q as string || ''), bucket as string);
            res.json({ items });
        } catch (e: any) { 
            next(e); 
        }
    }

    static async sync(req: CascataRequest, res: any, next: any) {
        const bucket = req.params.bucket;
        try {
            StorageIndexer.syncLocalBucket(systemPool, req.project.slug, bucket).catch(e => console.error("Sync Error", e));
            await RateLimitService.invalidateProjectStorageUsage(req.project.slug); // Force recalculation after sync
            res.json({ success: true, message: "Synchronization started in background." });
        } catch(e: any) {
            next(e);
        }
    }

    static async serveFile(req: CascataRequest, res: any, next: any) {
        const relativePath = req.params[0];
        const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };
        
        if (storageConfig.provider !== 'local') {
             return res.status(404).json({ error: "File is hosted externally. Use direct links." });
        }

        const bucketPath = path.join(STORAGE_ROOT, req.project.slug, req.params.bucket);
        const filePath = path.join(bucketPath, relativePath);
        if (!filePath.startsWith(bucketPath)) return res.status(403).json({ error: 'Path Traversal Detected' });
        
        try { await fs.access(filePath); res.sendFile(filePath); } 
        catch { res.status(404).json({ error: 'File Not Found' }); }
    }

    static async moveFiles(req: CascataRequest, res: any, next: any) {
        const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };
        if (storageConfig.provider !== 'local') return res.status(501).json({ error: "Move operation not supported for external providers yet." });

        try {
            const { bucket, paths, destination } = req.body;
            const root = path.join(STORAGE_ROOT, req.project.slug);
            const destPath = path.join(root, destination.bucket || bucket, destination.path || '');
            await fs.mkdir(destPath, { recursive: true });
            let movedCount = 0;
            
            for (const itemPath of paths) {
                const source = path.join(root, bucket, itemPath);
                const target = path.join(destPath, path.basename(itemPath));
                try { 
                    await fs.rename(source, target); 
                    
                    const newRelPath = path.join(destination.path || '', path.basename(itemPath)).replace(/\\/g, '/');
                    
                    await StorageIndexer.unindexObject(systemPool, req.project.slug, bucket, itemPath);
                    
                    try {
                        const stats = await fs.stat(target);
                        await StorageIndexer.indexObject(systemPool, req.project.slug, destination.bucket || bucket, newRelPath, {
                            size: stats.size, 
                            mimeType: 'application/octet-stream', 
                            isFolder: false, 
                            provider: 'local'
                        });
                    } catch (statErr) {
                         console.warn("Failed to stat moved file, index might be delayed", statErr);
                    }

                    movedCount++; 
                } catch (err: any) { console.warn(`Failed to move ${itemPath}: ${err.message}`); }
            }
            res.json({ success: true, moved: movedCount });
        } catch (e: any) { next(e); }
    }

    static async deleteObject(req: CascataRequest, res: any, next: any) {
        const storageConfig: StorageConfig = req.project.metadata?.storage_config || { provider: 'local' };
        const objectPath = req.query.path as string;

        try {
            if (storageConfig.provider === 'local') {
                const filePath = path.join(STORAGE_ROOT, req.project.slug, req.params.bucket, objectPath);
                const bucketRoot = path.join(STORAGE_ROOT, req.project.slug, req.params.bucket);
                if (!filePath.startsWith(bucketRoot)) return res.status(403).json({ error: 'Access Denied' });
                await fs.rm(filePath, { recursive: true, force: true });
            } else {
                const key = path.join(req.params.bucket, objectPath).replace(/\\/g, '/');
                await StorageService.delete(key, storageConfig);
            }
            
            await StorageIndexer.unindexObject(systemPool, req.project.slug, req.params.bucket, objectPath);
            
            // Invalidate Cache to force recount
            await RateLimitService.invalidateProjectStorageUsage(req.project.slug);

            res.json({ success: true });
        } catch (e: any) { next(e); }
    }
}
