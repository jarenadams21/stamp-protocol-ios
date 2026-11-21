import { EmailClient } from "@azure/communication-email";
import { SmsClient } from "@azure/communication-sms";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

/** Delivers a one-time sign-in code by text message or email. */
export interface CodeSender {
    readonly label: string;
    sendCode(to: string, code: string): Promise<void>;
}

export const smsText = (code: string) => `${code} is your JOEYY code. It expires in 10 minutes. Don't share it.`;
export const emailSubject = "Your JOEYY sign-in code";
export const emailText = (code: string) =>
    `Your JOEYY sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email. JOEYY will never ask you for this code.`;
const emailHtml = (code: string) =>
    `<p>Your JOEYY sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p>` +
    `<p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email. JOEYY will never ask you for this code.</p>`;

/**
 * Azure Communication Services SMS, signed in with DefaultAzureCredential like the database and
 * Blob Storage, so there is no access key. `from` is the resource's phone number.
 */
export class AzureSmsSender implements CodeSender {
    readonly label: string;
    private readonly client: SmsClient;
    private readonly from: string;

    constructor(options: { endpoint: string; from: string; credential?: TokenCredential }) {
        this.client = new SmsClient(options.endpoint, options.credential ?? new DefaultAzureCredential());
        this.from = options.from;
        this.label = `Azure Communication Services SMS (${new URL(options.endpoint).host})`;
    }

    async sendCode(to: string, code: string) {
        const [result] = await this.client.send({ from: this.from, to: [to], message: smsText(code) });
        if (!result?.successful) throw new Error(`SMS not sent: ${result?.errorMessage ?? "no result"}`);
    }
}

/**
 * Azure Communication Services Email, signed in the same way. `from` is a sender address on the
 * connected domain, for example DoNotReply@<id>.azurecomm.net. The send is accepted when this
 * returns; delivery finishes in the background, so sign-in doesn't wait on it.
 */
export class AzureEmailSender implements CodeSender {
    readonly label: string;
    private readonly client: EmailClient;
    private readonly from: string;

    constructor(options: { endpoint: string; from: string; credential?: TokenCredential }) {
        this.client = new EmailClient(options.endpoint, options.credential ?? new DefaultAzureCredential());
        this.from = options.from;
        this.label = `Azure Communication Services Email (${new URL(options.endpoint).host})`;
    }

    async sendCode(to: string, code: string) {
        await this.client.beginSend({
            senderAddress: this.from,
            recipients: { to: [{ address: to }] },
            content: { subject: emailSubject, plainText: emailText(code), html: emailHtml(code) },
        });
    }
}

/** AUTH_MODE=dev without Azure: writes the code to the server log instead of sending it. */
export class LogCodeSender implements CodeSender {
    readonly label: string;
    private readonly channel: string;
    private readonly log: (line: string) => void;

    constructor(channel: "SMS" | "email", log: (line: string) => void) {
        this.channel = channel;
        this.log = log;
        this.label = `server log (dev ${channel})`;
    }

    async sendCode(to: string, code: string) {
        this.log(`[dev ${this.channel} to ${to}] JOEYY sign-in code ${code}`);
    }
}

/** Tests: keeps every code in memory. */
export class MemoryCodeSender implements CodeSender {
    readonly label = "memory";
    readonly sent: { to: string; code: string }[] = [];
    failing = false;

    async sendCode(to: string, code: string) {
        if (this.failing) throw new Error("Provider unavailable");
        this.sent.push({ to, code });
    }

    lastCode(to: string): string | undefined {
        return this.sent.findLast((entry) => entry.to === to)?.code;
    }
}
