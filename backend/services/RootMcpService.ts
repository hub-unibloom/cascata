
import { systemPool, SYS_SECRET } from '../src/config/main.js';
import { DatabaseService } from './DatabaseService.js';
import { CertificateService } from './CertificateService.js';
import crypto from 'crypto';
import pg from 'pg';
import axios from 'axios';

const generateKey = () => crypto.randomBytes(32).toString('hex');

export class RootMcpService {
    
    /**
     * Contexto Global do Sistema
     */
    public static async getSystemContext(): Promise<string> {
        const res = await systemPool.query(`
            SELECT 
                (SELECT COUNT(*) FROM system.projects) as total_projects,
                (SELECT COUNT(*) FROM system.api_logs WHERE created_at > NOW() - INTERVAL '1 hour') as reqs_last_hour,
                (SELECT settings->>'domain' FROM system.ui_settings WHERE table_name = 'domain_config') as system_domain
        `);
        
        const stats = res.rows[0];
        
        let output = `--- CASCATA OMNI-GATEWAY (ROOT CONTEXT) ---\n`;
        output += `STATUS: OPERATIONAL\n`;
        output += `PROJECTS: ${stats.total_projects}\n`;
        output += `LOAD: ${stats.reqs_last_hour} reqs/h\n`;
        output += `DOMAIN: ${stats.system_domain || 'Not Configured'}\n\n`;
        output += `CAPABILITIES:\n`;
        output += `- Provision new isolated tenants (Projects)\n`;
        output += `- List and Audit existing projects\n`;
        output += `- Manage System Certificates\n`;
        
        return output;
    }

    public static async executeTool(toolName: string, args: any): Promise<any> {
        console.log(`[RootMCP] Executing: ${toolName}`);

        if (toolName === 'list_projects') {
            const res = await systemPool.query(`SELECT name, slug, status, created_at FROM system.projects ORDER BY created_at DESC LIMIT 20`);
            return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
        }

        if (toolName === 'create_project') {
            const { name, slug } = args;
            if (!name || !slug) throw new Error("Name and Slug required");

            const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;
            const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
            
            try {
                // 1. Generate Keys
                const keys = { anon: generateKey(), service: generateKey(), jwt: generateKey() };
                
                // 2. Register in System
                await systemPool.query(
                    "INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) VALUES ($1, $2, $3, pgp_sym_encrypt($4, $7), pgp_sym_encrypt($5, $7), pgp_sym_encrypt($6, $7), $8)", 
                    [name, safeSlug, dbName, keys.anon, keys.service, keys.jwt, SYS_SECRET, JSON.stringify({ timezone: 'UTC' })]
                );
                
                // 3. Provision DB
                await systemPool.query(`CREATE DATABASE "${dbName}"`);
                
                const dbHost = process.env.DB_DIRECT_HOST || 'db';
                const dbPort = process.env.DB_DIRECT_PORT || '5432';
                const user = process.env.DB_USER || 'cascata_admin';
                const pass = process.env.DB_PASS || 'secure_pass';
                
                const tempClient = new pg.Client({ connectionString: `postgresql://${user}:${pass}@${dbHost}:${dbPort}/${dbName}` });
                await tempClient.connect();
                await DatabaseService.initProjectDb(tempClient);
                await tempClient.end();
                
                // 4. Provision Vector Store
                try {
                    await axios.put(`${qdrantUrl}/collections/${safeSlug}`, { vectors: { size: 1536, distance: 'Cosine' } });
                } catch (qError) {}

                // 5. Rebuild Routing
                await CertificateService.rebuildNginxConfigs(systemPool);

                return { 
                    content: [{ type: "text", text: JSON.stringify({ 
                        success: true, 
                        message: "Project Provisioned Successfully",
                        keys: keys,
                        slug: safeSlug
                    }, null, 2) }] 
                };

            } catch (e: any) {
                return { isError: true, content: [{ type: "text", text: `Provisioning Failed: ${e.message}` }] };
            }
        }

        if (toolName === 'get_system_logs') {
             const res = await systemPool.query(`SELECT * FROM system.api_logs ORDER BY created_at DESC LIMIT 10`);
             return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
        }

        throw new Error("Unknown Tool");
    }
}
