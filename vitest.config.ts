import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    restoreMocks: true,
    // Plusieurs tests lancent de vrais processus (tar, node sur boite/src/cli.ts,
    // serveur MCP) ou ouvrent une base SQLite : sur un runner CI Windows charge,
    // ils depassent le timeout par defaut (5 s par test, 10 s par hook) et
    // echouent de facon intermittente. On elargit globalement au lieu de
    // surcharger chaque test.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
