
import { NextFunction } from 'express';
import axios from 'axios';
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

            // DETERMINAÇÃO DE CONNECTION STRING PARA O ENGINE
            // O Engine não tem acesso ao middleware `resolveProject`, então precisamos
            // passar a string de conexão explicitamente no contexto.
            let dbConnectionString = '';
            if (req.project.metadata?.external_db_url) {
                dbConnectionString = req.project.metadata.external_db_url;
            } else {
                const dbHost = process.env.DB_DIRECT_HOST || 'db';
                const dbPort = process.env.DB_DIRECT_PORT || '5432';
                const user = process.env.DB_USER || 'cascata_admin';
                const pass = process.env.DB_PASS || 'secure_pass';
                dbConnectionString = `postgresql://${user}:${pass}@${dbHost}:${dbPort}/${req.project.db_name}`;
            }

            const context = { 
                method: req.method, 
                body: req.body, 
                query: req.query, 
                headers: req.headers, 
                user: req.user,
                _db_connection_string: dbConnectionString // Contexto privilegiado para o Engine
            };

            const timeoutMs = (asset.metadata.timeout || 5) * 1000;

            // --- ENGINE OFFLOAD LOGIC ---
            // Se houver um ENGINE_URL configurado (Docker Service), delegamos a execução
            // para garantir isolamento de CPU/Memória.
            if (process.env.ENGINE_URL) {
                try {
                    // Comunicação síncrona interna (rápida na rede Docker)
                    const engineRes = await axios.post(`${process.env.ENGINE_URL}/internal/run`, {
                        code: asset.metadata.sql,
                        context,
                        envVars: finalEnv,
                        timeout: timeoutMs,
                        slug: req.project.slug
                    }, {
                        timeout: timeoutMs + 1000, // Margem de segurança para rede
                        validateStatus: () => true // Captura status code do engine
                    });

                    return res.status(engineRes.status).json(engineRes.data);
                } catch (engineErr: any) {
                    console.error('[EdgeController] Engine Offload Failed:', engineErr.message);
                    // Fallback se o Engine estiver offline? Não. Fail-Closed.
                    // Se o Engine caiu, é provável que estivesse sob ataque. 
                    // Tentar rodar na API principal agora seria suicídio.
                    return res.status(503).json({ error: "Execution Engine Unavailable. Please try again later." });
                }
            }

            // --- LOCAL FALLBACK (Legacy/Dev Mode) ---
            // Se não houver Engine configurado, roda no processo atual.
            const result = await EdgeService.execute(
                asset.metadata.sql, 
                context,
                finalEnv, 
                req.projectPool!, 
                timeoutMs,
                req.project.slug
            );
            res.status(result.status).json(result.body);
            
        } catch (e: any) { next(e); }
    }
}
