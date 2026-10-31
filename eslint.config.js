import pluginN from 'eslint-plugin-n'

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'site/**', 'dist/**'],
  },
  {
    plugins: { n: pluginN },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // Enforce `node:`-prefixed built-in imports (Sonar S7772)
      'n/prefer-node-protocol': 'error',
    },
  },
]
