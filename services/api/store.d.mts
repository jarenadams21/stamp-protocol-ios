import { DatabaseSync } from "node:sqlite";
import type { NativeCard } from "./src/native/store.ts";
export class CustomerStore {
    constructor(path: string);
    db: DatabaseSync;
    signup(username: string, password: string): Promise<{ token: string; username: string }>;
    authenticate(header: string): { id: string; username: string; sessionHash: string };
    seedCafe(name: string, target: number, tags: { uid: string; lastCounter?: number }[]): { id: string; name: string; target: number };
    award(customerID: string, requestID: string, url: string, verified: { uid: string; counter: number }): {
        eventId: string;
        card: Omit<NativeCard, "version"> & { version: number };
        duplicate: boolean;
    };
    close(): void;
}
