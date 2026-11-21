import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PKPass } from 'passkit-generator';
import { initials, visitDate } from '../src/ui/stamp-style';
import { joeyyIcon, monogram, strip } from './pass-art';

// Builds a signed Apple Wallet pass (.pkpass) for one stamp card, in the passport look:
// the business's paper and ink, a strip of stamps, the reward, and an "Open my JOEYY card"
// link on the back. Signing needs an Apple Pass Type ID certificate; see apps/web/.wallet/README.md.

const WALLET_DIR = join(process.cwd(), '.wallet');
const FILES = {
  config: join(WALLET_DIR, 'pass-type.json'),
  signerCert: join(WALLET_DIR, 'signerCert.pem'),
  signerKey: join(WALLET_DIR, 'signerKey.pem'),
  wwdr: join(WALLET_DIR, 'wwdr.pem'),
};

interface PassTypeConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName?: string;
  signerKeyPassphrase?: string;
}

const readConfig = () => JSON.parse(readFileSync(FILES.config, 'utf8')) as PassTypeConfig;

/**
 * The Pass Type ID certificate and key. Besides signing passes, they authenticate the pushes
 * that tell Wallet a pass changed (see server/apns.ts).
 */
export function passTypeCredentials() {
  const config = readConfig();
  return {
    passTypeIdentifier: config.passTypeIdentifier,
    cert: readFileSync(FILES.signerCert),
    key: readFileSync(FILES.signerKey),
    passphrase: config.signerKeyPassphrase,
  };
}

export function walletStatus() {
  const missing = Object.entries(FILES)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  return { configured: missing.length === 0, missing };
}

export interface PassCard {
  businessId: string;
  name: string;
  location: string;
  reward: string;
  punches: number;
  required: number;
  rewardsReady: number;
  paper: string;
  ink: string;
  serial: string;
  /** "Open my JOEYY card" link for the back of the pass. */
  link?: string;
  /** Visit dates for the stamps on this card, oldest first. */
  dates: string[];
  /**
   * Where Wallet registers the pass for updates, and the secret it sends back. With these set,
   * the pass updates itself after a push. Wallet only calls HTTPS addresses, unless the iPhone's
   * Settings → Developer → Allow HTTP Services is on.
   */
  webService?: { url: string; authenticationToken: string };
}

function hex(color: string): [number, number, number] {
  const value = parseInt(color.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const clip = (value: string, max: number) => value.trim().slice(0, max);

/** Reads and checks the card from the request's query string. */
export function cardFromQuery(query: URLSearchParams): PassCard {
  const int = (key: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(query.get(key)) || 0)));
  const required = int('required', 3, 12);
  const paper = query.get('paper') ?? '';
  const ink = query.get('ink') ?? '';
  const link = query.get('link') ?? '';
  return {
    businessId: clip(query.get('business') ?? 'joeyy', 40).replace(/[^a-z0-9-]/gi, ''),
    name: clip(query.get('name') ?? 'JOEYY card', 40),
    location: clip(query.get('location') ?? '', 60),
    reward: clip(query.get('reward') ?? '', 60),
    punches: Math.min(int('punches', 0, 12), required),
    required,
    rewardsReady: int('rewards', 0, 99),
    paper: isHex(paper) ? paper : '#F1EADA',
    ink: isHex(ink) ? ink : '#22201C',
    serial: clip(query.get('serial') ?? `${Date.now()}`, 64).replace(/[^a-z0-9-]/gi, ''),
    link: /^https?:\/\//.test(link) ? clip(link, 300) : undefined,
    dates: (query.get('dates') ?? '').split(',').filter((date) => !Number.isNaN(Date.parse(date))).slice(-12),
  };
}

const rgb = (color: string, alpha = 1, over = '#FFFFFF') => {
  const [r, g, b] = hex(color);
  const [br, bg, bb] = hex(over);
  const mix = (front: number, back: number) => Math.round(front * alpha + back * (1 - alpha));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
};

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export function buildApplePass(card: PassCard) {
  const config = readConfig();
  const left = card.required - card.punches;
  const lastVisit = card.dates.at(-1);
  const lastDate = lastVisit ? visitDate(lastVisit) : undefined;
  const ready = card.rewardsReady > 0;
  // "Use my reward" signs the browser in like "Open my JOEYY card", then opens the redeem sheet.
  const useLink = card.link ? `${card.link}?use=reward` : undefined;
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeIdentifier,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName ?? 'JOEYY',
    serialNumber: card.serial,
    ...(card.webService
      ? { webServiceURL: card.webService.url, authenticationToken: card.webService.authenticationToken }
      : {}),
    description: `${card.name} stamp card`,
    logoText: card.name,
    backgroundColor: rgb(card.paper),
    foregroundColor: rgb(card.ink),
    // Labels a step quieter than values: the ink, faded toward the paper.
    labelColor: rgb(card.ink, 0.62, card.paper),
    sharingProhibited: true,
    storeCard: {
      // The header is all that shows while the pass sits in the Wallet stack, so a ready reward
      // takes it over from the visit count.
      headerFields: [
        ready
          ? { key: 'status', label: 'Reward', value: 'Ready' }
          : { key: 'status', label: 'Visits', value: `${card.punches}/${card.required}` },
      ],
      secondaryFields: [
        { key: 'reward', label: ready ? 'Ready to use' : 'Next reward', value: card.reward },
        ready
          ? { key: 'count', label: card.rewardsReady > 1 ? 'Rewards' : 'Visits', value: card.rewardsReady > 1 ? String(card.rewardsReady) : `${card.punches}/${card.required}`, textAlignment: 'PKTextAlignmentRight' }
          : { key: 'count', label: 'To go', value: String(left), textAlignment: 'PKTextAlignmentRight' },
      ],
      // Wallet puts secondary and auxiliary fields on one row under the strip, so keep it to two.
      backFields: [
        ...(ready && useLink
          ? [{
              key: 'use',
              label: 'Your reward',
              value: `Use my reward: ${useLink}`,
              attributedValue: `<a href="${useLink}">Use my reward</a>`,
            }]
          : []),
        ...(card.link
          ? [{
              key: 'open',
              label: 'Your card',
              value: `Open my JOEYY card: ${card.link}`,
              attributedValue: `<a href="${card.link}">Open my JOEYY card</a>`,
            }]
          : []),
        ...(lastDate ? [{ key: 'last', label: 'Last visit', value: dayFormat.format(lastDate) }] : []),
        ...(card.location ? [{ key: 'place', label: 'Where', value: card.location }] : []),
        // When the pass updates, Wallet shows changeMessage as a notification. It's only set while a
        // reward is ready, and the value stays the same until it's used, so later stamps stay quiet.
        ready
          ? { key: 'news', label: 'Reward', value: `${card.reward} is ready at ${card.name}. Use it at the counter.`, changeMessage: '%@' }
          : { key: 'news', label: 'Progress', value: `${left} ${left === 1 ? 'stamp' : 'stamps'} to your next reward.` },
        { key: 'how', label: 'How it works', value: 'Tap the JOEYY stand at the counter after you pay. Each visit adds a stamp.' },
        { key: 'honoured', label: 'Rewards', value: `Set and honoured by ${card.name}.` },
      ],
    },
  };

  const pass = new PKPass(
    {
      'pass.json': Buffer.from(JSON.stringify(passJson)),
      'icon.png': joeyyIcon(29),
      'icon@2x.png': joeyyIcon(58),
      'icon@3x.png': joeyyIcon(87),
      'logo.png': monogram(initials(card.name), card.ink, 1),
      'logo@2x.png': monogram(initials(card.name), card.ink, 2),
      'logo@3x.png': monogram(initials(card.name), card.ink, 3),
      'strip.png': strip(card, 1),
      'strip@2x.png': strip(card, 2),
      'strip@3x.png': strip(card, 3),
    },
    {
      wwdr: readFileSync(FILES.wwdr),
      signerCert: readFileSync(FILES.signerCert),
      signerKey: readFileSync(FILES.signerKey),
      signerKeyPassphrase: config.signerKeyPassphrase,
    },
  );
  return pass.getAsBuffer();
}

/** Just the strip, so the look can be checked without signing. */
export function previewArtwork(card: PassCard) {
  return { strip: strip(card, 2) };
}
