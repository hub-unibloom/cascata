
import { Pool } from 'pg';
import path from 'path';
import fsPromises from 'fs/promises';
import { STORAGE_ROOT } from '../src/config/main.js';

export interface IndexItem {
    size: number;
    mimeType: string;
    isFolder: boolean;
    provider: string;
}

/**
 * StorageIndexer
 * Responsible for maintaining the 'system.storage_objects' table.
 * Separated from StorageService to avoid circular dependencies and keep I/O logic pure.
 */
export class StorageIndexer {

    public static async indexObject(
        pool: Pool,
        projectSlug: string,
        bucket: string,
        fullPath: string, // relative to bucket root
        meta: IndexItem
    ) {
        try {
            const name = path.basename(fullPath);
            let parentPath = path.dirname(fullPath);
            if (parentPath === '.') parentPath = '';

            await pool.query(`
                INSERT INTO system.storage_objects 
                (project_slug, bucket, name, parent_path, full_path, is_folder, size, mime_type, provider, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                ON CONFLICT (project_slug, bucket, full_path) 
                DO UPDATE SET size = EXCLUDED.size, updated_at = NOW(), provider = EXCLUDED.provider
            `, [projectSlug, bucket, name, parentPath, fullPath, meta.isFolder, meta.size, meta.mimeType, meta.provider]);
        } catch (e) {
            console.error('[StorageIndex] Failed to index:', e);
        }
    }

    public static async unindexObject(pool: Pool, projectSlug: string, bucket: string, fullPath: string) {
        try {
            await pool.query(`
                DELETE FROM system.storage_objects 
                WHERE project_slug = $1 AND bucket = $2 AND (full_path = $3 OR full_path LIKE $4)
            `, [projectSlug, bucket, fullPath, `${fullPath}/%`]);
        } catch (e) {
            console.error('[StorageIndex] Failed to unindex:', e);
        }
    }

    public static async list(pool: Pool, projectSlug: string, bucket: string, parentPath: string) {
        // Normalize: "folder/" -> "folder"
        let targetPath = parentPath;
        if (targetPath.endsWith('/')) targetPath = targetPath.slice(0, -1);
        if (targetPath === '.') targetPath = '';

        const res = await pool.query(`
            SELECT name, is_folder, size, updated_at, full_path 
            FROM system.storage_objects 
            WHERE project_slug = $1 AND bucket = $2 AND parent_path = $3
            ORDER BY is_folder DESC, name ASC
        `, [projectSlug, bucket, targetPath]);

        return res.rows.map(row => ({
            name: row.name,
            type: row.is_folder ? 'folder' : 'file',
            size: parseInt(row.size),
            updated_at: row.updated_at,
            path: row.full_path
        }));
    }

    public static async search(pool: Pool, projectSlug: string, query: string, bucket?: string) {
        let sql = `
            SELECT name, is_folder, size, updated_at, full_path 
            FROM system.storage_objects 
            WHERE project_slug = $1 AND name ILIKE $2
        `;
        const params = [projectSlug, `%${query}%`];

        if (bucket) {
            sql += ` AND bucket = $3`;
            params.push(bucket);
        }
        sql += ` LIMIT 100`;

        const res = await pool.query(sql, params);
        return res.rows.map(row => ({
            name: row.name,
            type: row.is_folder ? 'folder' : 'file',
            size: parseInt(row.size),
            updated_at: row.updated_at,
            path: row.full_path
        }));
    }

    /**
     * SYNC: Scans physical disk and populates DB.
     * Only works for 'local' provider currently.
     */
    public static async syncLocalBucket(pool: Pool, projectSlug: string, bucketName: string) {
        const bucketRoot = path.join(STORAGE_ROOT, projectSlug, bucketName);
        
        const walkAndIndex = async (dir: string, relRoot: string) => {
            try {
                const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPathOnDisk = path.join(dir, entry.name);
                    const relPath = path.join(relRoot, entry.name).replace(/\\/g, '/');
                    
                    if (entry.isDirectory()) {
                        await this.indexObject(pool, projectSlug, bucketName, relPath, {
                            size: 0, mimeType: 'application/directory', isFolder: true, provider: 'local'
                        });
                        await walkAndIndex(fullPathOnDisk, relPath);
                    } else {
                        const stats = await fsPromises.stat(fullPathOnDisk);
                        await this.indexObject(pool, projectSlug, bucketName, relPath, {
                            size: stats.size, 
                            mimeType: 'application/octet-stream', 
                            isFolder: false, 
                            provider: 'local'
                        });
                    }
                }
            } catch (e) {
                // Ignore missing dirs
            }
        };

        await walkAndIndex(bucketRoot, '');
    }
}
