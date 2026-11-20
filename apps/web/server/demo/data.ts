import type { Business, ProgramVersion } from '../../src/api/types';

// The demo's sample places and stands. The businesses are fictional. In production these come
// from the partner app (programs) and from tag registration (stands).

interface DemoBusiness {
  business: Business;
  program: ProgramVersion;
}

interface DemoTag {
  businessId: string;
  /** allocated: shipped but not set up yet. disabled: lost, stolen or replaced. */
  status: 'active' | 'allocated' | 'disabled';
}

export const BUSINESSES: Record<string, DemoBusiness> = {
  norema: {
    business: {
      id: 'norema', name: 'Norema Cafe', location: 'Capitol Hill, Seattle', category: 'Café',
      address: '1500 E Olive Way, Seattle, WA', hoursToday: { opens: '07:00', closes: '18:00' },
    },
    program: {
      versionId: 'norema-v1',
      version: 1,
      requiredPunches: 10,
      rewardDescription: 'One handcrafted drink',
      theme: {
        lightPaper: '#F7EFD9', lightInk: '#2F241E', darkPaper: '#2F241E', darkInk: '#F7EFD9',
        typeface: 'serif', artwork: 'cloud', allowsMotion: true,
      },
    },
  },
  ferrous: {
    business: {
      id: 'ferrous', name: 'Ferrous Coffee', location: 'Belltown, Seattle', category: 'Espresso bar',
      address: '2200 2nd Ave, Seattle, WA', hoursToday: { opens: '06:30', closes: '16:00' },
    },
    program: {
      versionId: 'ferrous-v3',
      version: 3,
      requiredPunches: 8,
      rewardDescription: 'A free espresso',
      theme: {
        lightPaper: '#F5A174', lightInk: '#351B13', darkPaper: '#5C2C20', darkInk: '#FFE6D5',
        typeface: 'monospaced', artwork: 'rail', allowsMotion: true,
      },
    },
  },
  littlefog: {
    business: {
      id: 'littlefog', name: 'Little Fog Tea', location: 'Mount Pleasant, Vancouver', category: 'Tea house',
      address: '2400 Main St, Vancouver, BC', hoursToday: { opens: '10:00', closes: '19:00' },
    },
    program: {
      versionId: 'littlefog-v1',
      version: 1,
      requiredPunches: 6,
      rewardDescription: 'Any pot of tea',
      theme: {
        lightPaper: '#DDE9F2', lightInk: '#213849', darkPaper: '#223844', darkInk: '#DCE8F2',
        typeface: 'rounded', artwork: 'cloud', allowsMotion: true,
      },
    },
  },
  tallow: {
    business: {
      id: 'tallow', name: 'Tallow & Rye', location: 'Fremont, Seattle', category: 'Bakery',
      address: '3500 Fremont Ave N, Seattle, WA', hoursToday: { opens: '08:00', closes: '15:00' },
    },
    program: {
      versionId: 'tallow-v2',
      version: 2,
      requiredPunches: 8,
      rewardDescription: 'One pastry of your choice',
      theme: {
        lightPaper: '#E8DFC8', lightInk: '#353E2D', darkPaper: '#31382D', darkInk: '#F0E7D2',
        typeface: 'serif', artwork: 'stone', allowsMotion: true,
      },
    },
  },
  pholune: {
    business: {
      id: 'pholune', name: 'Pho Lune', location: 'Chinatown-International District, Seattle', category: 'Noodle house',
      address: '650 S Weller St, Seattle, WA', hoursToday: { opens: '11:00', closes: '21:00' },
    },
    program: {
      versionId: 'pholune-v1',
      version: 1,
      requiredPunches: 8,
      rewardDescription: 'A free bowl of pho',
      theme: {
        lightPaper: '#F3D9C9', lightInk: '#4A1F1A', darkPaper: '#4A1F1A', darkInk: '#F3D9C9',
        typeface: 'standard', artwork: 'cloud', allowsMotion: true,
      },
    },
  },
  marrow: {
    business: {
      id: 'marrow', name: 'Marrow Bakehouse', location: 'Kitsilano, Vancouver', category: 'Bakery',
      address: '2100 W 4th Ave, Vancouver, BC', hoursToday: { opens: '07:30', closes: '16:00' },
    },
    program: {
      versionId: 'marrow-v1',
      version: 1,
      requiredPunches: 6,
      rewardDescription: 'Any loaf on the shelf',
      theme: {
        lightPaper: '#E9E2F4', lightInk: '#2E2346', darkPaper: '#2E2346', darkInk: '#E9E2F4',
        typeface: 'serif', artwork: 'stone', allowsMotion: true,
      },
    },
  },
  sunday: {
    business: {
      id: 'sunday', name: 'Sunday Ramen', location: 'Gastown, Vancouver', category: 'Ramen bar',
      address: '300 Water St, Vancouver, BC', hoursToday: { opens: '12:00', closes: '22:00' },
    },
    program: {
      versionId: 'sunday-v2',
      version: 2,
      requiredPunches: 10,
      rewardDescription: 'Free extra toppings bowl',
      // The one sample place with its own repeat-stamp limit, for the "Already stamped" screen.
      minMinutesBetweenStamps: 30,
      theme: {
        lightPaper: '#F6E7A8', lightInk: '#3B2E07', darkPaper: '#3B2E07', darkInk: '#F6E7A8',
        typeface: 'rounded', artwork: 'rail', allowsMotion: true,
      },
    },
  },
  bluestem: {
    business: {
      id: 'bluestem', name: 'Bluestem Creamery', location: 'Ballard, Seattle', category: 'Ice cream',
      address: '5400 Ballard Ave NW, Seattle, WA', hoursToday: { opens: '12:00', closes: '22:00' },
    },
    program: {
      versionId: 'bluestem-v1',
      version: 1,
      requiredPunches: 7,
      rewardDescription: 'A double scoop, any flavours',
      theme: {
        lightPaper: '#CFE7DF', lightInk: '#123B33', darkPaper: '#123B33', darkInk: '#CFE7DF',
        typeface: 'rounded', artwork: 'cloud', allowsMotion: true,
      },
    },
  },
};

/** Demo tag keys stand in for the encrypted `picc` value a real NTAG 424 DNA produces. */
export const TAGS: Record<string, DemoTag> = {
  'norema-counter': { businessId: 'norema', status: 'active' },
  'ferrous-bar': { businessId: 'ferrous', status: 'active' },
  'littlefog-till': { businessId: 'littlefog', status: 'active' },
  'tallow-counter': { businessId: 'tallow', status: 'active' },
  'pholune-counter': { businessId: 'pholune', status: 'active' },
  'marrow-counter': { businessId: 'marrow', status: 'active' },
  'sunday-counter': { businessId: 'sunday', status: 'active' },
  'bluestem-counter': { businessId: 'bluestem', status: 'active' },
  'norema-new': { businessId: 'norema', status: 'allocated' },
  'norema-stolen': { businessId: 'norema', status: 'disabled' },
};

/** The stand at the counter for a business, for demo taps. */
export const counterTag = (businessId: string) =>
  Object.entries(TAGS).find(([, tag]) => tag.businessId === businessId && tag.status === 'active')?.[0];
