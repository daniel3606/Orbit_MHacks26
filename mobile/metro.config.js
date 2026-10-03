const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('svg')) {
  config.resolver.assetExts.push('svg');
}

module.exports = config;
