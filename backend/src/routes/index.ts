
import { Router } from 'express';
import controlRoutes from './control.routes.js';
import dataRoutes from './data.routes.js';
import pushRoutes from './push.routes.js';
import webhookRoutes from './webhook.routes.js';

const router = Router();

router.use('/control', controlRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/data/:slug/push', pushRoutes); // Namespace dedicado para Push
router.use('/data/:slug', dataRoutes);

export default router;
