import { defineConfig, loadEnv, type Plugin } from 'vite';

// Three modes, picked with --mode (see package.json):
//   demo  Sample data on the demo backend (server/demo), mounted in the dev and preview servers, with
//         the Preview states bar. For pitches on the team's phones. VITE_API_BASE is ignored.
//   api   The page in front of the shared API (services/api) running on this Mac: the dev and
//         preview servers pass /v1 through to API_TARGET (default http://localhost:8080), so the
//         page and the API share one origin and the diner's session cookie just works. A build in
//         this mode is the test site you can share through a tunnel (npm run preview:api).
//   prod  The real backend at VITE_API_BASE, which is required. No demo backend, no Wallet signing
//         here (the backend signs passes), and no demo code in the bundle.
// `vite` with no --mode is demo; `vite build` with no --mode is prod, so a forgotten flag can only
// fail a build, never ship sample data.
type AppMode = 'demo' | 'api' | 'prod';

function appModeFor(mode: string, command: 'serve' | 'build'): AppMode {
  if (mode === 'demo' || mode === 'api' || mode === 'prod') return mode;
  if (mode === 'production') return 'prod';
  if (mode === 'development' && command === 'serve') return 'demo';
  throw new Error(`Unknown mode "${mode}". Use --mode demo or --mode prod.`);
}

// The demo backend serves /v1/web/*, /api/demo/* and /api/wallet/apple/*. Loaded only in demo mode,
// so a prod server never answers with sample data.
function demoServer(): Plugin {
  const load = async () => (await import('./server/demo/routes')).demoBackend;
  return {
    name: 'joeyy-demo-backend',
    configureServer: async (server) => void server.middlewares.use(await load()),
    configurePreviewServer: async (server) => void server.middlewares.use(await load()),
  };
}

// Single-page app: /t (tag tap), /c (your cards), /r (redeem), /w (Wallet link) all serve index.html.
export default defineConfig(({ mode, command }) => {
  const appMode = appModeFor(mode, command);
  const apiBase = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE || process.env.VITE_API_BASE;
  if (appMode === 'prod' && !apiBase) {
    throw new Error(
      'Prod mode needs VITE_API_BASE (the real backend), e.g. VITE_API_BASE=https://api.joeyy.app npm run build. ' +
        'For sample data use npm run dev or npm run build:demo.',
    );
  }
  if (appMode === 'demo' && apiBase) {
    console.warn(`\n  Demo mode: ignoring VITE_API_BASE (${apiBase}). The page uses the demo backend.\n`);
  }
  const apiTarget = process.env.API_TARGET || 'http://localhost:8080';
  return {
    appType: 'spa',
    plugins: appMode === 'demo' ? [demoServer()] : [],
    define: {
      'import.meta.env.VITE_MODE': JSON.stringify(appMode),
      // Empty means "this origin": demo answers itself, api mode proxies to the API.
      'import.meta.env.VITE_API_BASE': JSON.stringify(appMode === 'prod' ? apiBase : ''),
    },
    // changeOrigin stays off: the API only accepts a write whose Origin matches the Host it sees.
    ...(appMode === 'api'
      ? {
          server: { proxy: { '/v1': { target: apiTarget, changeOrigin: false } } },
          preview: { proxy: { '/v1': { target: apiTarget, changeOrigin: false } }, allowedHosts: ['.trycloudflare.com'] },
        }
      : {}),
    build: { target: 'es2020', cssMinify: true },
    // A Cloudflare quick tunnel (cloudflared tunnel --url http://localhost:5180) gives the demo an
    // https:// address, which Wallet needs before passes can update themselves. Vite otherwise
    // refuses requests for host names it doesn't know.
    ...(appMode === 'demo'
      ? { server: { allowedHosts: ['.trycloudflare.com'] }, preview: { allowedHosts: ['.trycloudflare.com'] } }
      : {}),
  };
});
