import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import axios from 'axios';
import { URL } from 'url';
import dns from 'dns/promises';

const REDIS_CONFIG = {
    connection: {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379')
    }
};

export class QueueService {
    private static webhookQueue: Queue;
    private static webhookWorker: Worker;

    // SSRF Protection: Checks if IP is private/local/cloud-metadata
    private static isPrivateIP(ip: string): boolean {
        // IPv4 Check
        if (ip.includes('.')) {
            const parts = ip.split('.').map(Number);
            if (parts.length !== 4) return false; 

            // 0.0.0.0/8 (Current network)
            if (parts[0] === 0) return true;
            // 10.0.0.0/8 (Private)
            if (parts[0] === 10) return true;
            // 127.0.0.0/8 (Loopback)
            if (parts[0] === 127) return true;
            // 169.254.0.0/16 (Link-local / Cloud Metadata AWS/Azure/GCP)
            if (parts[0] === 169 && parts[1] === 254) return true;
            // 172.16.0.0/12 (Private)
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
            // 192.168.0.0/16 (Private)
            if (parts[0] === 192 && parts[1] === 168) return true;
        } 
        // IPv6 Check
        else if (ip.includes(':')) {
            // ::1 (Loopback)
            if (ip === '::1' || ip === '::') return true;
            // fc00::/7 (Unique Local)
            if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true;
            // fe80::/10 (Link Local)
            if (ip.toLowerCase().startsWith('fe80')) return true;
        }
        
        return false;
    }

    /**
     * Valida a URL de destino para prevenir SSRF (Server-Side Request Forgery).
     * Resolve o DNS do hostname e verifica se o IP resultante é seguro (público).
     */
    private static async validateTarget(targetUrl: string): Promise<void> {
        try {
            const url = new URL(targetUrl);
            const hostname = url.hostname;

            // 1. Block obvious localhost hostnames
            if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') {
                throw new Error("Blocked: localhost access denied");
            }
            
            // 2. Block internal service names (Docker DNS names)
            const internalServices = ['redis', 'db', 'backend_control', 'backend_data', 'nginx', 'nginx_controller'];
            if (internalServices.includes(hostname)) {
                throw new Error("Blocked: Internal service access denied");
            }

            // 3. DNS Resolution Check (The Real SSRF Check)
            // We verify what IP the hostname actually points to.
            let ips: string[] = [];
            
            // Check if hostname is already an IP
            const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');
            
            if (isIp) {
                ips = [hostname];
            } else {
                try {
                    // Resolve DNS
                    const records = await dns.lookup(hostname, { all: true });
                    ips = records.map(r => r.address);
                } catch (e) {
                    // If DNS fails, it's not a valid webhook target anyway
                    throw new Error(`DNS Resolution failed for ${hostname}`);
                }
            }

            // 4. Validate all resolved IPs
            for (const ip of ips) {
                if (this.isPrivateIP(ip)) {
                    throw new Error(`Security Violation: Host ${hostname} resolves to private IP ${ip}. Webhook blocked.`);
                }
            }

        } catch (e: any) {
            throw new Error(`SSRF Protection: ${e.message}`);
        }
    }

    public static init() {
        console.log('[QueueService] Initializing BullMQ Queues...');

        // 1. Definição da Fila de Webhooks
        this.webhookQueue = new Queue('cascata-webhooks', {
            ...REDIS_CONFIG,
            defaultJobOptions: {
                attempts: 5, // Tenta 5 vezes em caso de falha
                backoff: {
                    type: 'exponential',
                    delay: 1000, // 1s, 2s, 4s, 8s...
                },
                removeOnComplete: true, // Limpa sucesso para economizar RAM
                removeOnFail: 1000 // Mantém os últimos 1000 falhados para debug
            }
        });

        // 2. Worker (Processador) de Webhooks
        this.webhookWorker = new Worker('cascata-webhooks', async (job: Job) => {
            const { targetUrl, payload, secret, eventType, tableName } = job.data;
            
            // SECURITY CHECK BEFORE REQUEST
            await this.validateTarget(targetUrl);

            const signature = crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(payload))
                .digest('hex');

            try {
                console.log(`[Queue:Webhook] Processing job ${job.id} -> ${targetUrl}`);
                
                // Use default axios (Assuming DNS Rebinding is mitigated by pre-check mostly)
                // For extreme security, one would use a custom http agent that pins the IP resolved in validateTarget
                await axios.post(targetUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Cascata-Signature': signature,
                        'X-Cascata-Event': eventType,
                        'X-Cascata-Table': tableName,
                        'User-Agent': 'Cascata-Webhook-Engine/2.0'
                    },
                    timeout: 5000 // 5s timeout para não travar o worker
                });
                
                return { status: 'sent', timestamp: new Date() };
            } catch (error: any) {
                console.error(`[Queue:Webhook] Failed job ${job.id}: ${error.message}`);
                throw error; // Lança erro para o BullMQ agendar o retry
            }
        }, REDIS_CONFIG);

        this.webhookWorker.on('failed', (job, err) => {
            console.warn(`[Queue:Webhook] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`);
        });
    }

    public static async addWebhookJob(data: {
        targetUrl: string;
        payload: any;
        secret: string;
        eventType: string;
        tableName: string;
    }) {
        if (!this.webhookQueue) {
            console.warn('[QueueService] Queue not initialized, initializing lazy...');
            this.init();
        }
        await this.webhookQueue.add('dispatch', data);
    }

    public static async getMetrics() {
        if (!this.webhookQueue) return { waiting: 0, active: 0, failed: 0 };
        return await this.webhookQueue.getJobCounts('waiting', 'active', 'failed', 'completed');
    }
}