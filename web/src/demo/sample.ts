import type { SignInProvider } from '../api/types';

/** The Apple ID and Google account that the demo's stand-in consent sheet signs in with. */
export const SAMPLE_EMAILS: Record<SignInProvider, string> = {
  apple: 'sample.diner@icloud.com',
  google: 'sample.diner@gmail.com',
};
