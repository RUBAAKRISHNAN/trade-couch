/**
 * Production entry for small hosts (e.g. Render's free 512 MB plan): runs the matching engine, the API and the
 * worker in ONE Node process instead of three. Each app's main module starts itself when imported.
 * Locally, `npm run dev` still runs them separately.
 */
await import('../apps/engine/src/main');
await import('../apps/api/src/main');
await import('../apps/worker/src/main');

export {};
