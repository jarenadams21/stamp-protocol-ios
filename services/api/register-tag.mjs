import { CustomerStore } from "./store.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const [uidOrImport, inputPath] = process.argv.slice(2);
await mkdir(resolve("data"), { recursive: true, mode: 0o700 });
const store = new CustomerStore(join(resolve("data"), "customers.sqlite"));
try {
  let tags;
  if (uidOrImport === "--import-prototype" && inputPath) {
    const source = new DatabaseSync(resolve(inputPath), { readOnly: true });
    try { tags = source.prepare("SELECT uid,last_counter AS lastCounter FROM tags").all(); }
    finally { source.close(); }
  } else {
    if (!/^[0-9a-fA-F]{14}$/.test(uidOrImport ?? "")) throw new Error("Usage: node register-tag.mjs UID | --import-prototype /path/to/nfc.sqlite");
    tags = [{ uid: uidOrImport.toUpperCase() }];
  }
  store.seedCafe("Demo Cafe", 10, tags);
  console.log(`Linked ${tags.length} known chip(s) to the native test cafe. Existing customer balances were not changed.`);
} finally { store.close(); }
