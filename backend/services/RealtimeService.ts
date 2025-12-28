import { Response, Request } from 'express';
import { Client } from 'pg';
import { PoolService } from './PoolService.js';

interface ClientConnection {
    id: string;
    res: any;
    tableFilter?: string;
}

export class RealtimeService {
    // Mantém listas de clientes conectados por Projeto
    private static subscribers = new Map<string, Set<ClientConnection>>();
    // Mantém uma conexão PG dedicada para LISTEN por Projeto
    private static listeners = new Map<string, Client>();

    public static async handleConnection(req: any, res: any) {
        const slug = req.params.slug;
        const { table } = req.query;
        const headers = {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no' // Importante para Nginx não fazer buffer
        };
        res.writeHead(200, headers);

        // Envia confirmação de conexão
        const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

        // Garante que existe um Listener PG para este projeto
        if (!this.listeners.has(slug)) {
            await this.setupProjectListener(slug);
        }

        // Registra o cliente
        if (!this.subscribers.has(slug)) {
            this.subscribers.set(slug, new Set());
        }
        
        const connection: ClientConnection = {
            id: clientId,
            res,
            tableFilter: table as string
        };
        
        this.subscribers.get(slug)!.add(connection);

        // Heartbeat para manter conexão viva através de Load Balancers
        const heartbeat = setInterval(() => {
            res.write(': ping\n\n');
        }, 15000);

        // Cleanup ao desconectar
        req.on('close', () => {
            clearInterval(heartbeat);
            this.subscribers.get(slug)?.delete(connection);
            
            // Se não houver mais ninguém ouvindo, fecha a conexão com o banco para economizar recursos
            if (this.subscribers.get(slug)?.size === 0) {
                this.teardownProjectListener(slug);
            }
        });
    }

    private static async setupProjectListener(slug: string) {
        console.log(`[Realtime] Starting PG Listener for ${slug}`);
        try {
            // Precisamos de um Client dedicado (não Pool) para LISTEN
            const pool = PoolService.get(`cascata_proj_${slug.replace(/-/g, '_')}`);
            // Hack: Extrair config do pool para criar client direto
            // Em produção real, a connectionString estaria disponível
            const client = await pool.connect(); 
            const connectionString = (pool as any).options?.connectionString || process.env.SYSTEM_DATABASE_URL?.replace('cascata_system', `cascata_proj_${slug.replace(/-/g, '_')}`);
            client.release(); // Solta o do pool

            const listenerClient = new Client({ connectionString });
            await listenerClient.connect();
            
            await listenerClient.query('LISTEN cascata_events');

            listenerClient.on('notification', (msg) => {
                if (msg.channel === 'cascata_events' && msg.payload) {
                    this.broadcast(slug, JSON.parse(msg.payload));
                }
            });

            listenerClient.on('error', (err) => {
                console.error(`[Realtime] Listener Error ${slug}:`, err);
                this.teardownProjectListener(slug);
            });

            this.listeners.set(slug, listenerClient);

        } catch (e) {
            console.error(`[Realtime] Failed to setup listener for ${slug}`, e);
        }
    }

    private static teardownProjectListener(slug: string) {
        const client = this.listeners.get(slug);
        if (client) {
            console.log(`[Realtime] Closing PG Listener for ${slug}`);
            client.end().catch(() => {});
            this.listeners.delete(slug);
        }
    }

    private static broadcast(slug: string, payload: any) {
        const clients = this.subscribers.get(slug);
        if (!clients) return;

        const message = `data: ${JSON.stringify(payload)}\n\n`;

        clients.forEach(client => {
            // Filtra se o cliente pediu apenas uma tabela específica
            if (!client.tableFilter || client.tableFilter === payload.table) {
                client.res.write(message);
            }
        });
    }
}