import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { EdgeService } from '../../services/EdgeService.js';

export class EdgeController {
    static async execute(req: CascataRequest, res: any, next: any) {
        try {
            const assetRes = await systemPool.query("SELECT * FROM system.assets WHERE project_slug = $1 AND name = $2 AND type = 'edge_function'", [req.project.slug, req.params.name]);
            if (assetRes.rows.length === 0) return res.status(404).json({ error: "Edge Function Not Found" });
            const asset = assetRes.rows[0];
            
            const globalSecrets = req.project.metadata?.secrets || {};
            const localEnv = asset.metadata.env_vars || {};
            const finalEnv = { ...globalSecrets, ...localEnv };

            const result = await EdgeService.execute(
                asset.metadata.sql, 
                { method: req.method, body: req.body, query: req.query, headers: req.headers, user: req.user }, 
                finalEnv, 
                req.projectPool!, 
                (asset.metadata.timeout || 5) * 1000,
                req.project.slug // NEW: Passing slug for vector isolation
            );
            res.status(result.status).json(result.body);
        } catch (e: any) { next(e); }
    }
}
