import { constants, type BigIntStats } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function fileState(path: string) {
    try { return await stat(path, { bigint: true }); }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}
function sameFile(before: BigIntStats | undefined, after: BigIntStats | undefined) {
    if (!before || !after) return before === after;
    return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
        before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/**
 * Even a read-only SQLite connection can create/write -shm. Never open the original
 * with SQLite: copy the stopped writer's main file AND committed WAL into a private
 * ignored workspace, where SQLite may rebuild its disposable shared-memory index.
 */
export async function snapshotLegacySource(source: string) {
    await mkdir(resolve(".dev"), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(resolve(".dev/native-import-snapshot-"));
    try {
        const [main, wal, journal] = await Promise.all([fileState(source), fileState(`${source}-wal`), fileState(`${source}-journal`)]);
        if (!main?.isFile() || (wal && !wal.isFile()) || (journal && journal.size > 0n)) {
            throw new Error("Legacy source must be a stopped, intact SQLite database without a pending rollback journal.");
        }
        const path = join(directory, "customers.sqlite");
        await copyFile(source, path, constants.COPYFILE_EXCL);
        await chmod(path, 0o600);
        if (wal) {
            await copyFile(`${source}-wal`, `${path}-wal`, constants.COPYFILE_EXCL);
            await chmod(`${path}-wal`, 0o600);
        }
        const [afterMain, afterWal, afterJournal] = await Promise.all([fileState(source), fileState(`${source}-wal`), fileState(`${source}-journal`)]);
        if (!sameFile(main, afterMain) || !sameFile(wal, afterWal) || !sameFile(journal, afterJournal)) {
            throw new Error("Legacy source changed while snapshotting. Stop all legacy writers before importing.");
        }
        return { path, remove: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}
