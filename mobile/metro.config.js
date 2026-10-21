// Metro (the bundler): the default Expo configuration, plus the web frontend's source folder.
// The app imports a few dependency-free modules straight from ../frontend/src (alias @web/*, tsconfig.json):
// translations, number / colour helpers, the ERP module mapping, the wheel geometry, icon paths. Metro only
// bundles files inside its watch folders, so that folder is added here. Those files import nothing outside
// themselves (checked by __tests__/shared.test.ts). What the build adds to them (Babel helpers, the React Native
// polyfills) is resolved from this app's node_modules: CI installs only mobile/, never frontend/node_modules.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, '../frontend/src')];
config.resolver.nodeModulesPaths = [...(config.resolver.nodeModulesPaths || []), path.resolve(__dirname, 'node_modules')];

module.exports = config;
