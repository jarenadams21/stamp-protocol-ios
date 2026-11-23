import './styles/tokens.css';
import './styles/base.css';
import './styles/card.css';
import './styles/screens.css';
import './styles/frame.css';
import './styles/motion.css';
import { createApi } from './api';
import { interceptLinks, navigate, resolve, route } from './router';
import { cardsScreen, legalScreen, signedInScreen, walletRestoreScreen } from './screens/cards';
import { homeScreen } from './screens/home';
import { discoverScreen } from './screens/discover';
import { profileScreen } from './screens/profile';
import { redeemScreen } from './screens/redeem';
import { tapScreen } from './screens/tap';
import { installSpringEasings } from './ui/spring';

async function start() {
  installSpringEasings();
  // iOS only shows :active (press feedback) once the page listens for touches.
  document.addEventListener('touchstart', () => undefined, { passive: true });
  // The header's hairline shows only once content scrolls under it.
  const edge = () => document.documentElement.toggleAttribute('data-scrolled', window.scrollY > 4);
  window.addEventListener('scroll', edge, { passive: true });
  const api = await createApi();
  route('/', () => homeScreen(api));
  route('/t', (_params, query) => tapScreen(api, query));
  // The paths the team's programmed stands use (the app's verifier accepts all three).
  for (const path of ['/tap', '/tag', '/tagtt']) route(path, (_params, query) => tapScreen(api, query));
  route('/c', (_params, query) => cardsScreen(api, query.get('open') ?? undefined));
  // A card's own address opens it in Your cards, so a card looks the same however you get to it.
  route('/c/:businessId', ({ businessId }) => navigate(`/c?open=${encodeURIComponent(businessId)}`, { replace: true }));
  route('/r/:intentId', ({ intentId }) => redeemScreen(api, intentId));
  route('/w/:token', ({ token }) => walletRestoreScreen(api, token));
  route('/signed-in', (_params, query) => signedInScreen(api, query));
  route('/discover', (_params, query) => discoverScreen(api, query.get('q') ?? ''));
  route('/me', () => profileScreen(api));
  // The business site, loaded only when an owner opens it.
  const business = () => import('./business');
  route('/business', async () => (await business()).landingScreen());
  route('/business/sign-in', async () => (await business()).signInScreen());
  route('/business/setup', async (_params, query) => (await business()).setupScreen(query));
  route('/business/today', async () => (await business()).todayScreen());
  route('/business/card', async () => (await business()).cardScreen());
  route('/business/stands', async () => (await business()).standsScreen());
  route('/privacy', () => legalScreen(api, 'privacy'));
  route('/terms', () => legalScreen(api, 'terms'));

  interceptLinks();
  void resolve();
  // The Sample data bar and Preview states: demo build only, so prod never bundles them.
  if (import.meta.env.VITE_MODE === 'demo') void import('./demo/panel').then(({ mountDemoPanel }) => mountDemoPanel());
}

void start();
