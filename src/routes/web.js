// Web route assembly (order matters: specific routes registered by sub-routers).
const express = require('express');
const router = express.Router();

router.use(require('./auth'));
router.use(require('./assets'));
router.use(require('./inventory'));
router.use(require('./operations'));
router.use(require('./platform'));
router.use(require('./admin'));

module.exports = router;
