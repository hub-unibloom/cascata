
import { Router } from 'express';
import express from 'express';
import { AdminController } from '../controllers/AdminController.js';
import { BackupController } from '../controllers/BackupController.js';
import { SecretsController } from '../controllers/SecretsController.js';
import { McpController } from '../controllers/McpController.js'; 
import { backupUpload } from '../config/main.js';
import { cascataAuth } from '../middlewares/core.js';
import { controlPlaneFirewall } from '../middlewares/security.js';

const router = Router();

router.use(express.json({ limit: '10mb' }) as any);
router.use(express.urlencoded({ extended: true, limit: '10mb' }) as any);

// Public / Auth
router.post('/auth/login', AdminController.login as any);
router.post('/auth/verify', AdminController.verify as any);
router.post('/system/ssl-check', AdminController.checkSsl as any);

// Protected Routes
router.use(controlPlaneFirewall as any);
router.use(cascataAuth as any);

// ROOT MCP
router.get('/mcp/sse', McpController.connectRootSSE as any);
router.post('/mcp/message', McpController.handleRootMessage as any);

router.get('/me/ip', (req: any, res: any) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    res.json({ ip: String(ip).replace('::ffff:', '') });
});

router.put('/auth/profile', AdminController.updateProfile as any);
router.get('/system/settings', AdminController.getSystemSettings as any);
router.post('/system/settings', AdminController.updateSystemSettings as any);
router.get('/system/certificates/status', AdminController.listCertificates as any);
router.post('/system/certificates', AdminController.createCertificate as any);
router.delete('/system/certificates/:domain', AdminController.deleteCertificate as any);
router.post('/system/webhooks/:id/test', AdminController.testWebhook as any);
router.get('/system/logs', AdminController.getSystemLogs as any);

// Projects
router.get('/projects', AdminController.listProjects as any);
router.post('/projects', AdminController.createProject as any);
router.patch('/projects/:slug', AdminController.updateProject as any);
router.delete('/projects/:slug', AdminController.deleteProject as any);
router.get('/projects/:slug/export', AdminController.exportProject as any);

// Security
router.post('/projects/:slug/reveal-key', AdminController.revealKey as any);
router.post('/projects/:slug/rotate-keys', AdminController.rotateKeys as any);
router.post('/projects/:slug/secrets', AdminController.updateSecrets as any);
router.post('/projects/:slug/block-ip', AdminController.blockIp as any);
router.delete('/projects/:slug/blocklist/:ip', AdminController.unblockIp as any);
router.delete('/projects/:slug/logs', AdminController.purgeLogs as any);
router.post('/projects/:slug/logs/export-cloud', AdminController.exportLogsToCloud as any); 
router.get('/projects/operations/:id', AdminController.getOperationStatus as any);

// BACKUP POLICIES
router.get('/projects/:slug/backups/policies', BackupController.listPolicies as any);
router.post('/projects/:slug/backups/policies', BackupController.createPolicy as any);
router.post('/projects/:slug/backups/validate', BackupController.validateConfig as any);
router.patch('/projects/:slug/backups/policies/:id', BackupController.updatePolicy as any);
router.delete('/projects/:slug/backups/policies/:id', BackupController.deletePolicy as any);
router.post('/projects/:slug/backups/policies/:id/run', BackupController.triggerManual as any);
router.get('/projects/:slug/backups/history', BackupController.getHistory as any);
router.get('/projects/:slug/backups/history/:historyId/download', BackupController.getDownloadLink as any);
router.post('/projects/:slug/backups/history/:historyId/restore', BackupController.restoreBackup as any);

// SECURE VAULT
router.get('/projects/:slug/vault', SecretsController.list as any);
router.post('/projects/:slug/vault', SecretsController.create as any);
router.post('/projects/:slug/vault/:id/reveal', SecretsController.reveal as any);
router.delete('/projects/:slug/vault/:id', SecretsController.delete as any);

// WEBHOOKS
router.get('/projects/:slug/webhooks', AdminController.listWebhooks as any);
router.post('/projects/:slug/webhooks', AdminController.createWebhook as any);
router.patch('/projects/:slug/webhooks/:id', AdminController.updateWebhook as any);
router.delete('/projects/:slug/webhooks/:id', AdminController.deleteWebhook as any);

// IMPORT ENGINE V3 (Migration Flow)
router.post('/projects/import/upload', backupUpload.single('file') as any, AdminController.uploadImport as any);
router.post('/projects/import/analyze', AdminController.analyzeImport as any); // Step 1: Diff
router.post('/projects/import/execute', AdminController.executeImport as any); // Step 2: Migrate
router.post('/projects/import/revert', AdminController.revertImport as any);   // Step 3: Panic Button

// LEGACY (Templates)
router.post('/projects/import/confirm', AdminController.confirmImport as any);

export default router;
