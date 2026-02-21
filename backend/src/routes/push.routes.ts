
import { Router } from 'express';
import { PushController } from '../controllers/PushController.js';
import { cascataAuth } from '../middlewares/core.js';

const router = Router({ mergeParams: true });

router.use(cascataAuth as any);

// App-facing routes
router.post('/devices', PushController.registerDevice as any);

// Server/RPC-facing routes
router.post('/send', PushController.sendPush as any);

// Management routes (Dashboard)
router.get('/rules', PushController.listRules as any);
router.post('/rules', PushController.createRule as any);
router.delete('/rules/:id', PushController.deleteRule as any);
router.get('/history', PushController.listHistory as any);

export default router;
