
import { Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { CascataRequest } from '../types.js';
import { STORAGE_ROOT, systemPool } from '../config/main.js';
import { getSectorForExt, validateMagicBytesAsync, parseBytes, resolveStorageConfig } from '../utils/index.js';
import { StorageService, StorageConfig } from '../../services/StorageService.js';
import { StorageIndexer } from '../../services/StorageIndexer.js';
import { RateLimitService } from '../../services/RateLimitService.js';

export class StorageController {

    /**
     * SECURITY: Resolves a filesystem path and guarantees it is strictly inside `root`.
     * Uses path.resolve (not path.join) so that any `..` sequences, absolute paths, or
     * URL-encoded tricks are collapsed before the containment check is performed.
     * Throws unconditionally if the resolved target escapes root.
     */
    private static getSafePath(root: string, ...segments: string[]): string {
        const resolvedRoot = path.resolve(root);
        // Sanitise each segment: strip leading slashes and any `..` sequences.
        const safeSegments = segments
            .filter(s => s != null && s !== '')
            .map(s => String(s).replace(/\.\./g, '').replace(/^\/+/, ''));
        const resolvedTarget = path.resolve(resolvedRoot, ...safeSegments);
        // Enforce strict containment — target must be inside root (or equal to root itself).
        if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
            throw Object.assign(new Error('Security Violation: Path Traversal Detected'), { status: 403 });
        }
        return resolvedTarget;
    }

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

            // 1. Check Dragonfly Cache (Fastest)
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
                    } catch (physErr: unknown) {
                        // If physical check fails (e.g., permission, timeout), ignore and stick to Logical.
                        console.warn(`[StorageQuota] Physical check failed for ${projectSlug}, using logical.`, (physErr as Error).message);
                    }
                }

                currentUsage = logicalSize;

                // 4. Update Cache (TTL 1h)
                await RateLimitService.setProjectStorageUsage(projectSlug, currentUsage);
            }

            // 5. Add In-Flight Reservations (Dragonfly)
            const reserved = await RateLimitService.getReservedStorage(projectSlug);
            const totalProjected = currentUsage + reserved + incomingSize;

            if (totalProjected > limit) {
                return { allowed: false };
            }

            // 6. Reserve Space for this upload
            const resId = await RateLimitService.reserveStorage(projectSlug, incomingSize);
            return { allowed: true, reservationId: resId || undefined };

        } catch (e: unknown) {
            console.error("Quota Check Failed:", (e as Error).message);
            // FAIL OPEN (Safety Net) with small hard limit to prevent total outage on Dragonfly/DB failure
            return { allowed: incomingSize < 50 * 1024 * 1024 };
        }
    }

    static async listBuckets(req: Request, res: Response, next: NextFunction): Promise<void> {
        const r = (req as unknown) as CascataRequest;
        try {
            const p = path.join(STORAGE_ROOT, r.project.slug);
            await fs.mkdir(p, { recursive: true });

            const items = await fs.readdir(p, { withFileTypes: true });
            const buckets = items
                .filter(dirent => dirent.isDirectory())
                .map(dirent => ({ name: dirent.name }));

            res.json(buckets);
        } catch (e: unknown) {
            next(e);
        }
    }

    static async createBucket(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const { name } = req.body as { name: string };
        try {
            const p = StorageController.getSafePath(STORAGE_ROOT, r.project.slug, name);
            await fs.mkdir(p, { recursive: true });
            res.json({ success: true });
        } catch (e: unknown) {
            if ((e as any)?.status === 403) return res.status(403).json({ error: 'Access Denied: Invalid bucket name' });
            next(e);
        }
    }

    static async renameBucket(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const { name } = req.params;
        const { newName } = req.body as { newName: string };

        try {
            const projRoot = StorageController.getSafePath(STORAGE_ROOT, r.project.slug);
            const oldPath = StorageController.getSafePath(projRoot, name);
            const newPath = StorageController.getSafePath(projRoot, newName);

            try { await fs.access(oldPath); }
            catch { return res.status(404).json({ error: 'Bucket not found' }); }

            try { await fs.access(newPath); return res.status(400).json({ error: 'Name already exists' }); }
            catch { }

            await fs.rename(oldPath, newPath);

            try {
                await systemPool.query(
                    'UPDATE system.storage_objects SET bucket = $1 WHERE project_slug = $2 AND bucket = $3',
                    [newName, r.project.slug, name]
                );
            } catch (dbErr: unknown) {
                console.error('[StorageController] DB Update Failed. Rolling back filesystem...', (dbErr as Error).message);
                try {
                    await fs.rename(newPath, oldPath);
                    return res.status(500).json({ error: 'System Error: Database update failed, filesystem change reverted.' });
                } catch (rollbackErr: unknown) {
                    console.error('[StorageController] CRITICAL: Rollback failed!', (rollbackErr as Error).message);
                    return res.status(500).json({ error: 'Critical Error: Storage system in inconsistent state. Contact Admin.' });
                }
            }

            res.json({ success: true });
        } catch (e: unknown) {
            res.status(500).json({ error: 'Rename failed: ' + (e as Error).message });
        }
    }

    static async deleteBucket(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        try {
            const { name } = req.params;

            // SECURITY FIX: Prevent deleting the root directory (Self-Wipe)
            if (!name || name === '.' || name === '..') {
                return res.status(400).json({ error: 'Invalid bucket name structure.' });
            }

            const projectSlug = r.project.slug;
            // getSafePath enforces containment — no need for a secondary startsWith check.
            const projRoot = StorageController.getSafePath(STORAGE_ROOT, projectSlug);
            const bucketPath = StorageController.getSafePath(projRoot, name);

            // 1. External Provider Cleanup
            const storageConfig: StorageConfig = r.project.metadata?.storage_config || { provider: 'local' };

            if (storageConfig.provider !== 'local') {
                const objects = await systemPool.query(
                    'SELECT full_path FROM system.storage_objects WHERE project_slug=$1 AND bucket=$2',
                    [projectSlug, name]
                );

                const deletionPromises = objects.rows.map(row => {
                    const fullPath = row.full_path as string;
                    return StorageService.delete(fullPath, storageConfig)
                        .catch((err: Error) => console.warn(`[Storage] Failed to delete orphan ${fullPath}:`, err.message));
                });

                await Promise.allSettled(deletionPromises);
            }

            // 2. Local Cleanup (Filesystem)
            await fs.rm(bucketPath, { recursive: true, force: true });

            // 3. Metadata Cleanup
            await systemPool.query('DELETE FROM system.storage_objects WHERE project_slug=$1 AND bucket=$2', [projectSlug, name]);

            // 4. Invalidate Quota Cache (Force Recalculation)
            await RateLimitService.invalidateProjectStorageUsage(projectSlug);

            res.json({ success: true });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    }

    static async createFolder(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        try {
            const { name, path: relativePath } = req.body as { name: string; path?: string };
            const bucketPath = StorageController.getSafePath(STORAGE_ROOT, r.project.slug, req.params.bucket);
            // getSafePath resolves the absolute path and asserts containment — throws 403-tagged Error on traversal.
            const targetDir = StorageController.getSafePath(bucketPath, relativePath || '', name);

            try { await fs.access(targetDir); return res.status(400).json({ error: 'Folder already exists' }); }
            catch { }

            await fs.mkdir(targetDir, { recursive: true });

            const fullRelPath = path.join(relativePath || '', name).replace(/\\/g, '/');
            StorageIndexer.indexObject(systemPool, r.project.slug, req.params.bucket, fullRelPath, {
                size: 0, mimeType: 'application/directory', isFolder: true, provider: 'local'
            });

            res.json({ success: true });
        } catch (e: unknown) {
            if ((e as any)?.status === 403) return res.status(403).json({ error: 'Access Denied: Path Traversal' });
            res.status(500).json({ error: (e as Error).message });
        }
    }

    // --- HYBRID UPLOAD SYSTEM ---

    static async signUpload(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        let reservationId: string | undefined;
        try {
            const { name, type, size, path: targetPath } = req.body as { name: string; type: string; size: number; path?: string };
            const ext = path.extname(name).replace('.', '').toLowerCase();
            const storageConfig: StorageConfig = resolveStorageConfig(r.project.metadata, ext);

            const limit = r.project.metadata?.storage_limit || '1GB';
            const quotaCheck = await StorageController.checkQuota(r.project.slug, size || 0, limit, storageConfig.provider);

            if (!quotaCheck.allowed) {
                return res.status(402).json({ error: 'Storage Quota Exceeded. Upgrade plan or delete files.' });
            }
            reservationId = quotaCheck.reservationId;

            const governance = r.project.metadata?.storage_governance || {};
            const sector = getSectorForExt(ext);
            const rule = (governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] }) as { max_size: string; allowed_exts: string[] };

            if (rule.allowed_exts && rule.allowed_exts.length > 0 && !rule.allowed_exts.includes(ext)) {
                if (reservationId) await RateLimitService.releaseStorage(r.project.slug, reservationId);
                return res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` });
            }
            if (size && size > parseBytes(rule.max_size)) {
                if (reservationId) await RateLimitService.releaseStorage(r.project.slug, reservationId);
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
                proxyUrl: result.strategy === 'proxy' ? `/api/data/${r.project.slug}/storage/${bucket}/upload` : undefined
            });

        } catch (e: unknown) {
            if (reservationId) await RateLimitService.releaseStorage(r.project.slug, reservationId);
            res.status(500).json({ error: (e as Error).message });
        }
    }

    static async uploadFile(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const multerReq = (req as unknown) as { file: any; body: any; params: any }; 
        if (!multerReq.file) return res.status(400).json({ error: 'No file found in request body.' });

        let reservationId: string | undefined;
        const cleanup = async (): Promise<void> => {
            try { await fs.unlink(multerReq.file.path as string); } catch (e: unknown) { }
            if (reservationId) await RateLimitService.releaseStorage(r.project.slug, reservationId);
        };

        try {
            const originalName = multerReq.file.originalname as string;
            const size = multerReq.file.size as number;
            const mimetype = multerReq.file.mimetype as string;
            const tempPath = multerReq.file.path as string;

            const ext = path.extname(originalName).replace('.', '').toLowerCase();
            const storageConfig: StorageConfig = resolveStorageConfig(r.project.metadata, ext);

            const limit = r.project.metadata?.storage_limit || '1GB';
            const quotaCheck = await StorageController.checkQuota(r.project.slug, size, limit, storageConfig.provider);

            if (!quotaCheck.allowed) {
                await cleanup();
                return res.status(402).json({ error: 'Storage Quota Exceeded. Physical limit reached.' });
            }
            reservationId = quotaCheck.reservationId;

            const governance = r.project.metadata?.storage_governance || {};
            const sector = getSectorForExt(ext);
            const rule = (governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] }) as { max_size: string; allowed_exts: string[] };

            if (rule.allowed_exts && rule.allowed_exts.length > 0 && !rule.allowed_exts.includes(ext)) {
                await cleanup();
                return res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` });
            }
            const isValidSig = await validateMagicBytesAsync(tempPath, ext);
            if (!isValidSig) {
                await cleanup();
                return res.status(400).json({ error: 'Security Alert: File signature mismatch.' });
            }
            if (size > parseBytes(rule.max_size)) {
                await cleanup();
                return res.status(403).json({ error: `Policy Violation: File size exceeds limit.` });
            }

            const bucket = req.params.bucket;

            let relativePath = req.body.path as string || '';
            relativePath = relativePath.replace(new RegExp(`^${bucket}/`), '').replace(/^\/+/, '');

            const resultUrl = await StorageService.upload(multerReq.file, r.project.slug, bucket, relativePath, storageConfig);

            if (storageConfig.provider === 'local') {
                const dest = StorageController.getSafePath(STORAGE_ROOT, r.project.slug, bucket, relativePath, originalName);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fs.rename(tempPath, dest);
                } catch (moveErr: unknown) {
                    if ((moveErr as any).code === 'EXDEV') {
                        await fs.copyFile(tempPath, dest);
                        await fs.unlink(tempPath);
                    } else { throw moveErr; }
                }
                res.json({ success: true, path: dest.replace(STORAGE_ROOT, ''), provider: 'local' });
            } else {
                try { await fs.unlink(tempPath); } catch (e: unknown) { }
                res.json({ success: true, path: resultUrl, provider: storageConfig.provider, url: resultUrl });
            }

            const fullKey = path.join(relativePath, originalName).replace(/\\/g, '/');
            StorageIndexer.indexObject(systemPool, r.project.slug, bucket, fullKey, {
                size: size,
                mimeType: mimetype,
                isFolder: false,
                provider: storageConfig.provider
            });

            // Invalidate Cache to force recount on next quota check
            await RateLimitService.invalidateProjectStorageUsage(r.project.slug);

            // Release reservation explicitly
            if (reservationId) await RateLimitService.releaseStorage(r.project.slug, reservationId);

        } catch (e: unknown) {
            await cleanup();
            console.error("Upload Error:", (e as Error).message);
            res.status(500).json({ error: (e as Error).message || 'Storage Error' });
        }
    }

    static async listFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
        const r = (req as unknown) as CascataRequest;
        const { path: queryPath } = req.query;
        try {
            const items = await StorageIndexer.list(systemPool, r.project.slug, req.params.bucket, (queryPath as string) || '');
            res.json({ items });
        } catch (e: unknown) {
            console.error("[Storage] List Error", (e as Error).message);
            res.json({ items: [] });
        }
    }

    static async search(req: Request, res: Response, next: NextFunction): Promise<void> {
        const r = (req as unknown) as CascataRequest;
        const { q, bucket } = req.query;
        try {
            const items = await StorageIndexer.search(systemPool, r.project.slug, (q as string || ''), bucket as string);
            res.json({ items });
        } catch (e: unknown) {
            next(e);
        }
    }

    static async sync(req: Request, res: Response, next: NextFunction): Promise<void> {
        const r = (req as unknown) as CascataRequest;
        const bucket = req.params.bucket;
        try {
            StorageIndexer.syncLocalBucket(systemPool, r.project.slug, bucket).catch((e: Error) => console.error("Sync Error", e.message));
            await RateLimitService.invalidateProjectStorageUsage(r.project.slug); // Force recalculation after sync
            res.json({ success: true, message: "Synchronization started in background." });
        } catch (e: unknown) {
            next(e);
        }
    }

    static async serveFile(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const relativePath = req.params[0];
        const storageConfig: StorageConfig = r.project.metadata?.storage_config || { provider: 'local' };

        if (storageConfig.provider !== 'local') {
            return res.status(404).json({ error: "File is hosted externally. Use direct links." });
        }

        const bucketPath = StorageController.getSafePath(STORAGE_ROOT, r.project.slug, req.params.bucket);
        const filePath = StorageController.getSafePath(bucketPath, relativePath);

        try { await fs.access(filePath); res.sendFile(filePath); }
        catch { res.status(404).json({ error: 'File Not Found' }); }
    }

    static async moveFiles(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const storageConfig: StorageConfig = r.project.metadata?.storage_config || { provider: 'local' };
        if (storageConfig.provider !== 'local') return res.status(501).json({ error: "Move operation not supported for external providers yet." });

        try {
            const { bucket, paths, destination } = req.body as { bucket: string; paths: string[]; destination: { bucket?: string; path?: string } };
            const root = StorageController.getSafePath(STORAGE_ROOT, r.project.slug);
            const destPath = StorageController.getSafePath(root, destination.bucket || bucket, destination.path || '');
            await fs.mkdir(destPath, { recursive: true });
            let movedCount = 0;

            for (const itemPath of paths) {
                // path.basename prevents any leftover `..` in the final filename segment.
                const source = StorageController.getSafePath(root, bucket, itemPath);
                const target = StorageController.getSafePath(destPath, path.basename(itemPath));
                try {
                    await fs.rename(source, target);

                    const newRelPath = path.join(destination.path || '', path.basename(itemPath)).replace(/\\/g, '/');

                    await StorageIndexer.unindexObject(systemPool, r.project.slug, bucket, itemPath);

                    try {
                        const stats = await fs.stat(target);
                        await StorageIndexer.indexObject(systemPool, r.project.slug, destination.bucket || bucket, newRelPath, {
                            size: stats.size,
                            mimeType: 'application/octet-stream',
                            isFolder: false,
                            provider: 'local'
                        });
                    } catch (statErr: unknown) {
                        console.warn("Failed to stat moved file, index might be delayed", (statErr as Error).message);
                    }

                    movedCount++;
                } catch (err: unknown) { console.warn(`Failed to move ${itemPath}: ${(err as Error).message}`); }
            }
            res.json({ success: true, moved: movedCount });
        } catch (e: unknown) { next(e); }
    }

    static async deleteObject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const r = (req as unknown) as CascataRequest;
        const storageConfig: StorageConfig = r.project.metadata?.storage_config || { provider: 'local' };
        const objectPath = req.query.path as string;

        // SECURITY FIX: Prevent structural manipulation
        if (!objectPath || objectPath === '.' || objectPath === '..') {
            return res.status(400).json({ error: 'Invalid object path structure.' });
        }

        try {
            if (storageConfig.provider === 'local') {
                const bucketRoot = StorageController.getSafePath(STORAGE_ROOT, r.project.slug, req.params.bucket);
                const filePath = StorageController.getSafePath(bucketRoot, objectPath);
                await fs.rm(filePath, { recursive: true, force: true });
            } else {
                const key = path.join(req.params.bucket, objectPath).replace(/\\/g, '/');
                await StorageService.delete(key, storageConfig);
            }

            await StorageIndexer.unindexObject(systemPool, r.project.slug, req.params.bucket, objectPath);

            // Invalidate Cache to force recount
            await RateLimitService.invalidateProjectStorageUsage(r.project.slug);

            res.json({ success: true });
        } catch (e: unknown) { next(e); }
    }
}
