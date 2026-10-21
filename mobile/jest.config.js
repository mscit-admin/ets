// Unit tests (no device): pure helpers of the app and the modules shared with the web frontend.
const preset = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  // sse.js (the live-updates stream) is published as an ES module: transform it like the React Native packages
  transformIgnorePatterns: preset.transformIgnorePatterns.map(p => p.replace('|standard-navigation))', '|standard-navigation|sse\\.js))')),
  roots: ['<rootDir>/__tests__'],
  // files imported from ../frontend/src get their Babel helpers from this app's node_modules (CI installs only mobile/)
  modulePaths: ['<rootDir>/node_modules'],
  moduleNameMapper: {
    '^@web/(.*)$': '<rootDir>/../frontend/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
