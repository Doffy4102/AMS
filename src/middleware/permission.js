// Port of PermissionMiddleware + ModuleMiddleware (parameterized guards).
const authz = require('../services/authorizationService');
const moduleService = require('../services/moduleService');
const { currentUser } = require('./auth');
const { HttpError } = require('../core/helpers');

function perm(permission) {
  return (req, res, next) => {
    (async () => {
      const user = await currentUser(req);
      await authz.requirePermission(permission, user);
      next();
    })().catch(next);
  };
}

function mod(moduleKey) {
  return (req, res, next) => {
    (async () => {
      if (!(await moduleService.isEnabled(moduleKey))) {
        const label = moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1);
        throw new HttpError(`The ${label} module is currently disabled by system administration.`, 403);
      }
      next();
    })().catch(next);
  };
}

module.exports = { perm, mod };
