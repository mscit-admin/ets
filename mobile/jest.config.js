// Unit tests (no device): pure helpers of the app and the modules shared with the web frontend.
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/__tests__'],
  // files imported from ../frontend/src get their Babel helpers from this app's node_modules (CI installs only mobile/)
  modulePaths: ['<rootDir>/node_modules'],
  moduleNameMapper: {
    '^@web/(.*)$': '<rootDir>/../frontend/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
