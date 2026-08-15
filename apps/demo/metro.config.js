// Metro configuration for a npm-workspaces monorepo.
//
// Without this, Metro only watches apps/demo and will not pick up edits to
// packages/axs-core — you would have to rebuild and reinstall the package on
// every change instead of getting fast refresh.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace so changes in packages/* trigger a reload.
config.watchFolders = [workspaceRoot];

// Resolve from the app first, then the hoisted workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// @axs/core ships ESM with "exports"; make sure Metro honours it.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
