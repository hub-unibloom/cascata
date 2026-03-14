
import { Router } from 'express';
import { WebhookController } from '../controllers/WebhookController.js';
import { cascataAuth } from '../middlewares/core.js';

const router = Router();

// 1. PUBLIC GATEWAY: No Auth middleware here, auth is handled inside handleIncoming
router.post('/in/:projectSlug/:pathSlug', WebhookController.handleIncoming as any);

// 2. MANAGEMENT (Requires Admin/Project Token)
router.get('/:slug/receivers', cascataAuth as any, WebhookController.list as any);
router.post('/:slug/receivers', cascataAuth as any, WebhookController.create as any);
router.delete('/:slug/receivers/:id', cascataAuth as any, WebhookController.delete as any);

export default router;
