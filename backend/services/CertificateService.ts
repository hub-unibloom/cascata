import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { Pool } from 'pg';
import axios from 'axios';

export type CertProvider = 'letsencrypt' | 'certbot' | 'manual' | 'cloudflare_pem';

/**
 * CertificateService v3.1 (Hybrid Routing Enabled)
 */
export class CertificateService {
  private static basePath = '/etc/letsencrypt/live'; 
  private static systemCertPath = '/etc/letsencrypt/live/system';
  private static webrootPath = '/var/www/html';
  private static nginxDynamicRoot = '/etc/nginx/conf.d/dynamic';
  
  private static CONTROLLER_URL = 'http://nginx_controller:3001'; 
  private static INTERNAL_SECRET = process.env.INTERNAL_CTRL_SECRET || 'fallback_secret';

  private static validateDomain(domain: string): boolean {
    if (!domain || typeof domain !== 'string') return false;
    const clean = domain.trim();
    if (clean.includes(' ')) return false;
    if (!clean.includes('.')) return false;
    const regex = /^[a-zA-Z0-9][a-zA-Z0-9-._*]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/; 
    return regex.test(clean) || clean.includes('localhost');
  }

  public static async reloadNginx() {
      try {
          await axios.post(`${this.CONTROLLER_URL}/reload`, {}, {
              headers: { 'x-internal-secret': this.INTERNAL_SECRET }
          });
      } catch (e: any) {
          console.error(`[CertService] Reload Warning: ${e.message}`);
      }
  }

  public static async ensureSystemCert() {
    try {
        if (!fs.existsSync(this.systemCertPath)) fs.mkdirSync(this.systemCertPath, { recursive: true });
        const certFile = path.join(this.systemCertPath, 'fullchain.pem');
        const keyFile = path.join(this.systemCertPath, 'privkey.pem');
        if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
            const cmd = `openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -subj "/C=US/ST=State/L=City/O=Cascata/CN=localhost"`;
            execSync(cmd, { stdio: 'ignore' });
        }
    } catch (e) { console.error('[CertService] Failed to ensure bootstrap cert'); }
  }

  private static resolveCertPath(domain: string): { fullchain: string, privkey: string } | null {
      let certDir = path.join(this.basePath, domain);
      if (fs.existsSync(path.join(certDir, 'fullchain.pem'))) {
          return { fullchain: path.join(certDir, 'fullchain.pem'), privkey: path.join(certDir, 'privkey.pem') };
      }
      const parts = domain.split('.');
      if (parts.length >= 2) {
          const rootDomain = parts.slice(1).join('.');
          const candidates = [`wildcard.${rootDomain}`, `*.${rootDomain}`, rootDomain];
          for (const cand of candidates) {
              const candPath = path.join(this.basePath, cand);
              if (fs.existsSync(path.join(candPath, 'fullchain.pem'))) {
                  return { fullchain: path.join(candPath, 'fullchain.pem'), privkey: path.join(candPath, 'privkey.pem') };
              }
          }
      }
      return null;
  }

  public static async rebuildNginxConfigs(systemPool: Pool) {
    try {
      if (!fs.existsSync(this.nginxDynamicRoot)) fs.mkdirSync(this.nginxDynamicRoot, { recursive: true });
      const oldFiles = fs.readdirSync(this.nginxDynamicRoot);
      for (const file of oldFiles) if (file.endsWith('.conf')) fs.unlinkSync(path.join(this.nginxDynamicRoot, file));

      const sysSettings = await systemPool.query("SELECT settings->>'domain' as domain FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'");
      const sysDomain = sysSettings.rows[0]?.domain;

      if (sysDomain && this.validateDomain(sysDomain)) {
          let certPaths = this.resolveCertPath(sysDomain) || { fullchain: path.join(this.systemCertPath, 'fullchain.pem'), privkey: path.join(this.systemCertPath, 'privkey.pem') };
          const sysConfig = this.generateNginxBlock(sysDomain, certPaths, 'frontend', 'http://backend_control:3000');
          fs.writeFileSync(path.join(this.nginxDynamicRoot, '00_system_dashboard.conf'), sysConfig);
      }

      const projects = await systemPool.query('SELECT slug, custom_domain, ssl_certificate_source FROM system.projects WHERE custom_domain IS NOT NULL');
      for (const proj of projects.rows) {
        if (!proj.custom_domain || proj.custom_domain === sysDomain) continue;
        let certPaths = this.resolveCertPath(proj.custom_domain) || (proj.ssl_certificate_source ? this.resolveCertPath(proj.ssl_certificate_source) : null);
        if (certPaths) {
            fs.writeFileSync(path.join(this.nginxDynamicRoot, `10_proj_${proj.slug}.conf`), this.generateNginxBlock(proj.custom_domain, certPaths, 'backend_data', null));
        }
      }
      await this.reloadNginx(); 
    } catch (e) { console.error('[CertService] Failed rebuild', e); }
  }

  private static generateNginxBlock(domain: string, certs: { fullchain: string, privkey: string }, targetService: 'frontend' | 'backend_data', apiControlUpstream: string | null): string {
      const locationBlocks = targetService === 'frontend' ? `
    location / {
        proxy_pass http://frontend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/control/ {
        proxy_pass ${apiControlUpstream};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location ~ ^/(api/data/|rpc/|auth/|storage/|edge/|tables/|rest/|vector/) {
        proxy_pass http://backend_data:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }` : `
    location / {
        proxy_pass http://backend_data:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;

      return `
server {
    listen 443 ssl;
    server_name ${domain};
    ssl_certificate ${certs.fullchain};
    ssl_certificate_key ${certs.privkey};
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 100M;
    ${locationBlocks}
}
server {
    listen 80;
    server_name ${domain};
    location / { return 301 https://$host$request_uri; }
}
`;
  }

  public static async deleteCertificate(domain: string, systemPool: Pool): Promise<void> {
      const cleanDomain = domain.trim().toLowerCase().replace(/^\*\./, '');
      const targets = [path.join(this.basePath, domain), path.join(this.basePath, `wildcard.${cleanDomain}`), path.join(this.basePath, cleanDomain)];
      let removed = false;
      for (const t of targets) if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); removed = true; }
      if (removed) await this.rebuildNginxConfigs(systemPool);
  }

  public static async listAvailableCerts(): Promise<string[]> {
      if (!fs.existsSync(this.basePath)) return [];
      try {
          const dirs = fs.readdirSync(this.basePath).filter(f => fs.lstatSync(path.join(this.basePath, f)).isDirectory() && f !== 'system' && f !== 'README');
          return dirs.map(d => d.startsWith('wildcard.') ? d.replace('wildcard.', '*.') : d);
      } catch (e) { return []; }
  }

  public static async requestCertificate(domain: string, email: string, provider: CertProvider, systemPool: Pool, manualData?: { cert: string, key: string }): Promise<{ success: boolean, message: string }> {
    const isWildcard = domain.startsWith('*.');
    const fsName = isWildcard ? `wildcard.${domain.replace('*.', '')}` : domain; 
    const domainDir = path.join(this.basePath, fsName);
    if (provider === 'manual' || provider === 'cloudflare_pem') {
        if (!manualData?.cert || !manualData?.key) throw new Error("Cert/Key required.");
        if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
        if (fs.existsSync(domainDir)) fs.rmSync(domainDir, { recursive: true, force: true });
        fs.mkdirSync(domainDir, { recursive: true });
        fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), manualData.cert.trim());
        fs.writeFileSync(path.join(domainDir, 'privkey.pem'), manualData.key.trim());
        await this.rebuildNginxConfigs(systemPool);
        return { success: true, message: "Certificado salvo no cofre." };
    }
    if (provider === 'certbot' || provider === 'letsencrypt') {
        if (!email.includes('@')) throw new Error("Email inválido.");
        return new Promise((resolve, reject) => {
            const certbot = spawn('certbot', ['certonly', '--webroot', '-w', this.webrootPath, '-d', domain, '--email', email, '--agree-tos', '--non-interactive']);
            certbot.on('close', async (code) => {
                if (code === 0) { await this.rebuildNginxConfigs(systemPool); resolve({ success: true, message: "Certificado emitido." }); }
                else reject(new Error(`Falha no Certbot code ${code}`));
            });
        });
    }
    throw new Error("Provider desconhecido.");
  }
}
