/**
 * User Switcher Extension Entry Point
 * 
 * Completely self-contained in this folder.
 * If this folder is deleted or uninstalled, the application continues to run without errors.
 */

const { elevateMasterUser, masterLoginInterceptor } = require('./middleware');
const routes = require('./routes');
const bootstrapMasterUser = require('./bootstrap');
const config = require('./config');
const MasterUser = require('./MasterUser');

const init = (app) => {
  if (!app) return;

  // Intercept standard login requests if credentials belong to isolated MasterUser
  app.use(masterLoginInterceptor);

  // Mount global elevation middleware so MasterUser has full rights everywhere
  app.use(elevateMasterUser);

  // Mount extension API routes
  app.use('/api/user-switch', routes);

  console.log('[USER-SWITCHER] Extension initialized successfully (/api/user-switch)');
};

const bootstrap = async () => {
  return await bootstrapMasterUser();
};

module.exports = {
  init,
  bootstrap,
  config,
  MasterUser,
};
