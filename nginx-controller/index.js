
import express from 'express';
import { exec } from 'child_process';

const app = express();
const PORT = 3001;

// SECURITY HARDENING: Fail start if no secret is provided
if (!process.env.INTERNAL_CTRL_SECRET) {
    console.error("[FATAL] INTERNAL_CTRL_SECRET environment variable is missing.");
    process.exit(1);
}
const INTERNAL_SECRET = process.env.INTERNAL_CTRL_SECRET;

app.use(express.json());

// Middleware de Autenticação Interna
app.use((req, res, next) => {
    const auth = req.headers['x-internal-secret'];
    if (auth !== INTERNAL_SECRET) {
        return res.status(403).json({ error: 'Forbidden: Invalid Internal Secret' });
    }
    next();
});

app.post('/reload', (req, res) => {
    const containerName = process.env.NGINX_CONTAINER_NAME || 'cascata-nginx';
    
    console.log(`[Controller] Reloading Nginx container: ${containerName}`);
    
    exec(`docker exec ${containerName} nginx -s reload`, (error, stdout, stderr) => {
        if (error) {
            console.error(`[Controller] Reload error: ${error.message}`);
            return res.status(500).json({ error: error.message, stderr });
        }
        console.log(`[Controller] Reload success: ${stdout}`);
        res.json({ success: true, message: 'Nginx reloaded successfully' });
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', role: 'nginx-sidecar' });
});

app.listen(PORT, () => {
    console.log(`[NginxController] Listening on port ${PORT}`);
});
