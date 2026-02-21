import axios from 'axios';
import { CascataRequest } from '../types.js';
import { RateLimitService } from '../../services/RateLimitService.js';

/**
 * VectorController v2.0
 * Hardened Zero-Trust Proxy.
 */
export class VectorController {
    
    static async proxy(req: CascataRequest, res: any, next: any) {
        const { slug } = req.project;
        const subPath = req.params[0] || '';
        const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
        
        try {
            // ZERO-TRUST BLOCK: Sincronia com Panic Mode
            // Embora o middleware resolveProject já verifique, uma checagem dupla no controller
            // garante que nenhum bypass de roteamento acesse o motor vetorial.
            const isPanic = await RateLimitService.checkPanic(slug);
            if (isPanic && !req.isSystemRequest) {
                return res.status(503).json({ error: "Security Lockdown: Vector Engine access suspended via Panic Mode." });
            }

            const targetUrl = `${qdrantUrl}/collections/${slug}${subPath ? '/' + subPath : ''}`;

            const response = await axios({
                method: req.method,
                url: targetUrl,
                data: req.body,
                params: req.query,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: () => true 
            });

            if (response.status === 404 && response.data?.status?.error?.includes('not found')) {
                return res.status(404).json({
                    error: "Vector Collection not found.",
                    hint: "Ensure the project is initialized correctly."
                });
            }

            res.status(response.status).json(response.data);
        } catch (e: any) {
            console.error(`[VectorProxy] Connection Error:`, e.message);
            res.status(502).json({ error: "Vector engine offline.", details: e.message });
        }
    }
}
