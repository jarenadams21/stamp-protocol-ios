import { SmsClient } from "@azure/communication-sms";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

/** Sends a sign-in code by text message. */
export interface SmsSender {
    readonly label: string;
    send(to: string, message: string): Promise<void>;
}

/**
 * Azure Communication Services, signed in with DefaultAzureCredential like the database and Blob
 * Storage, so there is no access key. The API's identity needs the "Communication and Email Service
 * Owner" role (or a custom role with SMS send) on the resource. `from` is the ACS phone number.
 */
export class AzureSmsSender implements SmsSender {
    readonly label: string;
    private readonly client: SmsClient;
    private readonly from: string;

    constructor(options: { endpoint: string; from: string; credential?: TokenCredential }) {
        this.client = new SmsClient(options.endpoint, options.credential ?? new DefaultAzureCredential());
        this.from = options.from;
        this.label = `Azure Communication Services (${new URL(options.endpoint).host})`;
    }

    async send(to: string, message: string) {
        const [result] = await this.client.send({ from: this.from, to: [to], message });
        if (!result?.successful) throw new Error(`SMS not sent: ${result?.errorMessage ?? "no result"}`);
    }
}

/** AUTH_MODE=dev without ACS: writes the message to the server log instead of sending it. */
export class LogSmsSender implements SmsSender {
    readonly label = "server log (dev)";
    private readonly log: (line: string) => void;

    constructor(log: (line: string) => void) {
        this.log = log;
    }

    async send(to: string, message: string) {
        this.log(`[dev SMS to ${to}] ${message}`);
    }
}

/** Tests: keeps every message in memory. */
export class MemorySmsSender implements SmsSender {
    readonly label = "memory";
    readonly sent: { to: string; message: string }[] = [];
    failing = false;

    async send(to: string, message: string) {
        if (this.failing) throw new Error("SMS provider unavailable");
        this.sent.push({ to, message });
    }

    /** The code in the last message sent to `to`. */
    lastCode(to: string): string | undefined {
        const message = this.sent.findLast((entry) => entry.to === to)?.message;
        return message?.match(/\b(\d{6})\b/)?.[1];
    }
}
