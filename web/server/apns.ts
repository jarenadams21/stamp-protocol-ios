import { connect, type ClientHttp2Session } from 'node:http2';
import { passTypeCredentials } from './apple-pass';

// Tells Wallet that a pass changed. Wallet passes always use Apple's production push service,
// authenticated with the Pass Type ID certificate, and the push itself is empty: Wallet answers
// by asking our web service which passes changed, then downloads them (see server/demo/passkit.ts).

const HOST = 'https://api.push.apple.com';

let session: ClientHttp2Session | undefined;

function apns() {
  if (session && !session.closed && !session.destroyed) return session;
  const { cert, key, passphrase } = passTypeCredentials();
  session = connect(HOST, { cert, key, passphrase });
  session.on('error', (error) => {
    console.warn(`[wallet] Push connection failed: ${error.message}`);
    session = undefined;
  });
  session.on('goaway', () => (session = undefined));
  // Don't keep the dev server alive just for an idle push connection.
  session.unref();
  return session;
}

interface PushResult {
  pushToken: string;
  status: number;
  reason?: string;
}

/** Sends the empty "this pass changed" push to one device. Resolves with Apple's answer. */
export function pushPassUpdate(pushToken: string): Promise<PushResult> {
  return new Promise((resolve) => {
    let request;
    try {
      request = apns().request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        'apns-topic': passTypeCredentials().passTypeIdentifier,
        'content-type': 'application/json',
      });
    } catch (error) {
      resolve({ pushToken, status: 0, reason: (error as Error).message });
      return;
    }
    let status = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => (status = Number(headers[':status'])));
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = body || undefined;
      }
      resolve({ pushToken, status, reason });
    });
    request.on('error', (error) => resolve({ pushToken, status: 0, reason: error.message }));
    request.setTimeout(10_000, () => request.close());
    request.end('{}');
  });
}
