import { createPool, transaction } from "../src/db.ts";
import { normalizeUUID } from "../src/native/store.ts";

// Explicit provisioning only: never creates a partner business or lowers a chip counter.
const args = process.argv.slice(2);
const [uidInput, cafeIDInput, counterInput = "-1"] = args.filter((arg) => arg !== "--apply");
if (!uidInput || !/^[0-9a-f]{14}$/i.test(uidInput) || !cafeIDInput || !/^-?\d+$/.test(counterInput)) {
    throw new Error("Usage: npm run native:link-tag -- UID CAFE_UUID [HIGH_WATER_COUNTER] [--apply]. Existing native cafe required; default dry-run.");
}
const cafeID = normalizeUUID(cafeIDInput), counter = Number(counterInput), uid = uidInput.toUpperCase();
if (!Number.isInteger(counter) || counter < -1 || counter > 0xffffff) throw new Error("Invalid chip high-water counter.");
const pool = createPool(process.env, { max: 1 });
try {
    await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`native-tag:${uid}`]);
        const cafe = await db.query("SELECT id FROM native_cafes WHERE id=$1", [cafeID]);
        if (!cafe.rowCount) throw new Error("Import or explicitly create the hardware-test cafe first.");
        const { rows: [old] } = await db.query<{ cafe_id: string; last_counter: number }>("SELECT * FROM native_tags WHERE uid=$1 FOR UPDATE", [uid]);
        if (old && (old.cafe_id !== cafeID || counter < old.last_counter)) throw new Error("Refusing chip reassignment or counter rollback.");
        if (args.includes("--apply")) {
            await db.query(
                `INSERT INTO native_tags(uid,cafe_id,last_counter) VALUES($1,$2,$3)
                 ON CONFLICT(uid) DO UPDATE SET last_counter=greatest(native_tags.last_counter,excluded.last_counter)
                 WHERE native_tags.cafe_id=excluded.cafe_id`, [uid, cafeID, counter]);
        }
    });
    console.log(JSON.stringify({ mode: args.includes("--apply") ? "applied" : "dry-run", tags: 1 }));
} catch {
    console.error("Tag provisioning refused; check native cafe and high-water counter. No chip identity logged.");
    process.exitCode = 1;
} finally { await pool.end(); }
