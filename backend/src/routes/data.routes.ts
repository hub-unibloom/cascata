
import { Router } from 'express';
import { DataController } from '../controllers/DataController.js';
import { StorageController } from '../controllers/StorageController.js';
import { AiController } from '../controllers/AiController.js';
import { EdgeController } from '../controllers/EdgeController.js';
import { SecurityController } from '../controllers/SecurityController.js';
import { DataAuthController } from '../controllers/DataAuthController.js';
import { VectorController } from '../controllers/VectorController.js';
import { McpController } from '../controllers/McpController.js';
import { BranchController } from '../controllers/BranchController.js';
import { upload } from '../config/main.js';
import { cascataAuth } from '../middlewares/core.js';
import { dynamicBodyParser, dynamicRateLimiter } from '../middlewares/security.js';
import { auditLogger } from '../middlewares/logging.js';
import { RealtimeService } from '../../services/RealtimeService.js';

const router = Router({ mergeParams: true });

// Apply Middlewares Chain
router.use(dynamicBodyParser as any);
router.use(dynamicRateLimiter as any);
router.use(auditLogger as any);
router.use(cascataAuth as any);

// ENVIRONMENT BRANCHING & SNAPSHOTS
router.get('/branch/status', BranchController.getStatus as any);
router.post('/branch/create', BranchController.createDraft as any);
router.post('/branch/sync', BranchController.syncFromLive as any);
router.delete('/branch/draft', BranchController.deleteDraft as any);
router.post('/branch/deploy', BranchController.deployDraft as any);
router.get('/branch/diff', BranchController.getDiff as any);

// NEW: Rollback System
router.get('/branch/snapshots', BranchController.listSnapshots as any);
router.post('/branch/rollback', BranchController.rollback as any);

// Realtime (SSE)
router.get('/realtime', (req: any, res: any) => RealtimeService.handleConnection(req, res));

// MCP Gateway (AI Agent Protocol)
router.get('/mcp/sse', McpController.connectSSE as any);
router.post('/mcp/message', McpController.handleMessage as any);

// Vector Memory Proxy (Hybrid Feature)
router.all('/vector/*', VectorController.proxy as any);
router.all('/vector', VectorController.proxy as any);

// Schema & Tables CRUD
router.get('/schemas', DataController.getSchemas as any);
router.get('/tables', DataController.listTables as any);
router.post('/tables', DataController.createTable as any);
router.get('/tables/:tableName/data', DataController.queryRows as any);
router.post('/tables/:tableName/rows', DataController.insertRows as any);
router.put('/tables/:tableName/rows', DataController.updateRows as any);
router.delete('/tables/:tableName/rows', DataController.deleteRows as any);
router.delete('/tables/:table', DataController.deleteTable as any);

// Schema & Recycle Bin
router.get('/tables/:tableName/columns', DataController.getColumns as any);
router.get('/recycle-bin', DataController.listRecycleBin as any);
router.post('/recycle-bin/:table/restore', DataController.restoreTable as any);

// RPC & Triggers
router.post('/rpc/:name', DataController.executeRpc as any);
router.get('/functions', DataController.listFunctions as any);
router.get('/triggers', DataController.listTriggers as any);
router.get('/rpc/:name/definition', DataController.getFunctionDefinition as any);

// EXTENSIONS (Phantom Injection Architecture)
router.get('/extensions', DataController.listExtensions as any);
router.post('/extensions/install', DataController.installExtension as any);
router.post('/extensions/uninstall', DataController.uninstallExtension as any);
router.get('/extensions/status/:name', DataController.getExtensionInstallStatus as any);

// Raw Query (Service Role Only)
router.post('/query', DataController.runRawQuery as any);

// Storage
router.get('/storage/buckets', StorageController.listBuckets as any);
router.post('/storage/buckets', StorageController.createBucket as any);
router.patch('/storage/buckets/:name', StorageController.renameBucket as any);
router.delete('/storage/buckets/:name', StorageController.deleteBucket as any);

// Storage Objects & Folders
router.post('/storage/:bucket/sign', StorageController.signUpload as any);
router.post('/storage/:bucket/folder', StorageController.createFolder as any);
router.post('/storage/:bucket/upload', upload.single('file') as any, StorageController.uploadFile as any);
router.get('/storage/:bucket/list', StorageController.listFiles as any);
router.get('/storage/search', StorageController.search as any);
router.get('/storage/:bucket/object/*', StorageController.serveFile as any);
router.post('/storage/move', StorageController.moveFiles as any);
router.delete('/storage/:bucket/object', StorageController.deleteObject as any);
router.post('/storage/:bucket/sync', StorageController.sync as any);

// PostgREST Compat
router.all('/rest/v1/:tableName', DataController.handlePostgrest as any);
router.post('/rest/v1/rpc/:name', DataController.executeRpc as any);
router.all('/rest/v1', DataController.getOpenApiSpec as any);

// AI & Docs
router.get('/ai/sessions', AiController.listSessions as any);
router.patch('/ai/sessions/:id', AiController.updateSession as any);
router.post('/ai/sessions/search', AiController.searchSessions as any);
router.post('/ai/chat', AiController.chat as any);
router.get('/ai/history/:session_id', AiController.getHistory as any);
router.post('/ai/fix-sql', AiController.fixSql as any);
router.post('/ai/explain', AiController.explain as any);
router.get('/docs/pages', AiController.listDocPages as any);
router.post('/ai/draft-doc', AiController.draftDoc as any);
router.get('/docs/openapi', AiController.getOpenApiSpec as any);

// Edge
router.post('/edge/:name', EdgeController.execute as any);

// Security
router.get('/security/status', SecurityController.getStatus as any);
router.post('/security/panic', SecurityController.togglePanic as any);
router.get('/rate-limits', SecurityController.listRateLimits as any);
router.post('/rate-limits', SecurityController.createRateLimit as any);
router.delete('/rate-limits/:id', SecurityController.deleteRateLimit as any);
router.get('/policies', SecurityController.listPolicies as any);
router.post('/policies', SecurityController.createPolicy as any);
router.delete('/policies/:table/:name', SecurityController.deletePolicy as any);
router.get('/logs', SecurityController.getLogs as any);

// Key Groups (New)
router.get('/security/key-groups', SecurityController.listKeyGroups as any);
router.post('/security/key-groups', SecurityController.createKeyGroup as any);
router.delete('/security/key-groups/:id', SecurityController.deleteKeyGroup as any);

// API Keys
router.get('/api-keys', SecurityController.listApiKeys as any);
router.post('/api-keys', SecurityController.createApiKey as any);
router.patch('/api-keys/:id', SecurityController.updateApiKey as any);
router.post('/api-keys/:id/migrate', SecurityController.migrateApiKey as any);
router.delete('/api-keys/:id', SecurityController.deleteApiKey as any);

// System Assets & Settings
router.get('/ui-settings/:table', DataController.getUiSettings as any);
router.post('/ui-settings/:table', DataController.saveUiSettings as any);
router.get('/assets', DataController.getAssets as any);
router.post('/assets', DataController.upsertAsset as any);
router.delete('/assets/:id', DataController.deleteAsset as any);
router.get('/assets/:id/history', DataController.getAssetHistory as any);
router.get('/stats', DataController.getStats as any);

// Auth (Data Plane)
router.get('/auth/users', DataAuthController.listUsers as any);
router.post('/auth/users', DataAuthController.createUser as any);
router.post('/auth/users/:id/identities', DataAuthController.linkIdentity as any);
router.delete('/auth/users/:id/strategies/:identityId', DataAuthController.unlinkIdentity as any);
router.patch('/auth/users/:id/status', DataAuthController.updateUserStatus as any);
router.delete('/auth/users/:id', DataAuthController.deleteUser as any);
router.post('/auth/token', DataAuthController.legacyToken as any);
router.post('/auth/link', DataAuthController.linkConfig as any);
router.post('/auth/challenge', DataAuthController.challenge as any);
router.post('/auth/verify-challenge', DataAuthController.verifyChallenge as any);

// GoTrue
router.post('/auth/v1/signup', DataAuthController.goTrueSignup as any);
router.post('/auth/v1/token', DataAuthController.goTrueToken as any);
router.get('/auth/v1/user', DataAuthController.goTrueUser as any);
router.post('/auth/v1/logout', DataAuthController.goTrueLogout as any);
router.get('/auth/v1/verify', DataAuthController.goTrueVerify as any);
router.get('/auth/v1/authorize', DataAuthController.goTrueAuthorize as any);
router.get('/auth/v1/callback', DataAuthController.goTrueCallback as any);

export default router;
