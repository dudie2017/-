import { Router } from 'express';
import * as alertService from '../services/alertService.js';

const router = Router();

// GET /api/v1/alerts - 获取所有预警
router.get('/', (req, res) => {
  try {
    const alerts = alertService.getAllAlerts();
    res.json(alerts);
  } catch (error) {
    console.error('Failed to get alerts:', error);
    res.status(500).json({ error: 'Failed to get alerts' });
  }
});

// GET /api/v1/alerts/smart - 获取智能预警
router.get('/smart', (req, res) => {
  try {
    const alerts = alertService.getSmartAlerts();
    res.json(alerts);
  } catch (error) {
    console.error('Failed to get smart alerts:', error);
    res.status(500).json({ error: 'Failed to get smart alerts' });
  }
});

// POST /api/v1/alerts/check - 检查并生成预警
router.post('/check', (req, res) => {
  try {
    const alerts = alertService.checkAndGenerateAlerts();
    res.json(alerts);
  } catch (error) {
    console.error('Failed to check alerts:', error);
    res.status(500).json({ error: 'Failed to check alerts' });
  }
});

// POST /api/v1/alerts/clear - 清除所有预警
router.post('/clear', (req, res) => {
  try {
    alertService.clearAlerts();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to clear alerts:', error);
    res.status(500).json({ error: 'Failed to clear alerts' });
  }
});

export default router;
