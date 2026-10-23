import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";

import type { CredentialStore } from "./list-todos";

export const KEYRING_SERVICE = "icourse163.mcp";
export const KEYRING_ACCOUNT = "cookie";

/**
 * Windows Credential Manager caps one credential blob at 2560 bytes (5 * 512), and
 * `@napi-rs/keyring` stores the password as UTF-16, so the practical ceiling for an
 * ASCII cookie header is 1280 characters. A full icourse163 session (7-14 cookies) is
 * 1700-2900 characters, i.e. it never fits.
 */
export const KEYCHAIN_MAX_CREDENTIAL_BYTES = 2560;

/** The three calls this module needs from the OS keychain; injectable for tests. */
export type KeychainEntry = {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  /** `@napi-rs/keyring` resolves `true`/`false` here rather than `void`. */
  deletePassword(): Promise<boolean | void>;
};

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type WritableCredentialStore = CredentialStore & {
  setCookie(cookie: string): Promise<void>;
  clearCookie(): Promise<void>;
};

export function defaultSessionFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg != null && xdg.length > 0) {
    return join(xdg, "icourse163-mcp", "session");
  }
  return join(home, ".config", "icourse163-mcp", "session");
}

export function createFileCredentialStore(options: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
} = {}): WritableCredentialStore {
  const path =
    options.path ??
    defaultSessionFilePath(options.env ?? process.env, options.homedir ?? homedir());

  return {
    async getCookie() {
      try {
        const raw = await readFile(path, "utf8");
        const trimmed = raw.trim();
        return trimmed.length === 0 ? null : trimmed;
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async setCookie(cookie: string) {
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      try {
        await chmodIfPresent(dirname(path), DIR_MODE);
      } catch {
        // Directory mode is best-effort on platforms that ignore mkdir mode.
      }
      const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(tmp, cookie, { encoding: "utf8", mode: FILE_MODE });
      try {
        await chmodIfPresent(tmp, FILE_MODE);
        await rename(tmp, path);
        await chmodIfPresent(path, FILE_MODE);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
      }
    },
    async clearCookie() {
      try {
        await unlink(path);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    },
  };
}

export function createKeyringCredentialStore(options: {
  fallback?: WritableCredentialStore;
  service?: string;
  account?: string;
  /** Injection seam; production always talks to the real OS keychain. */
  entry?: KeychainEntry;
} = {}): WritableCredentialStore {
  const fallback = options.fallback;
  const entry: KeychainEntry =
    options.entry ??
    new AsyncEntry(
      options.service ?? KEYRING_SERVICE,
      options.account ?? KEYRING_ACCOUNT,
    );

  return {
    async getCookie() {
      try {
        const value = await entry.getPassword();
        if (value != null && value.trim() !== "") {
          return value;
        }
      } catch (error) {
        logStoreError("Failed to read icourse163 cookie from keychain", error);
      }
      if (fallback != null) {
        return fallback.getCookie();
      }
      return null;
    },
    async setCookie(cookie: string) {
      if (!exceedsKeychainLimit(cookie)) {
        try {
          await entry.setPassword(cookie);
          return;
        } catch (error) {
          logStoreError(
            "Failed to write icourse163 cookie to keychain; using the file store",
            error,
          );
          if (fallback == null) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to write icourse163 cookie to keychain: ${detail}`, {
              cause: error,
            });
          }
        }
      }
      if (fallback == null) {
        throw new Error(
          `icourse163 cookie is ${utf16ByteLength(cookie)} bytes encoded as UTF-16, over the ` +
            `keychain limit of ${KEYCHAIN_MAX_CREDENTIAL_BYTES} bytes, and no file store is configured.`,
        );
      }
      // The keychain write did not land. Drop any older value before persisting the file:
      // getCookie() reads the keychain first, so a surviving stale entry would shadow the
      // fresh cookie forever — `login` keeps reporting success while every catalog tool
      // sees an empty account. See docs/adr/0005-urs-http-login.md.
      await dropKeychainValue(entry);
      await fallback.setCookie(cookie);
    },
    async clearCookie() {
      try {
        await entry.deletePassword();
      } catch (error) {
        logStoreError("Failed to clear icourse163 cookie from keychain", error);
      }
      if (fallback != null) {
        await fallback.clearCookie();
      }
    },
  };
}

function utf16ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf16le");
}

/**
 * Whether writing this cookie to the OS keychain is doomed on this platform.
 *
 * Only the Windows limit is modelled: it is the one that actually bites here, and the
 * guard is a cheap pre-check, not a portability claim. Short cookies still take the
 * normal write-and-handle-failure path, so other platforms keep keychain storage.
 */
function exceedsKeychainLimit(cookie: string): boolean {
  return utf16ByteLength(cookie) > KEYCHAIN_MAX_CREDENTIAL_BYTES;
}

/**
 * Remove a keychain value that must not outlive a skipped or failed keychain write.
 *
 * Best-effort by design: the file write that follows is the real fix, and a failure to
 * delete must not turn that into an error. A shadow that survives this is reported by
 * `npm run check:creds`.
 */
async function dropKeychainValue(entry: KeychainEntry): Promise<void> {
  let existing: string | null | undefined;
  try {
    existing = await entry.getPassword();
  } catch (error) {
    logStoreError("Failed to inspect the previous icourse163 keychain entry", error);
    return;
  }
  if (existing == null || existing === "") {
    return;
  }
  try {
    await entry.deletePassword();
  } catch (error) {
    logStoreError(
      "Failed to clear the previous icourse163 keychain entry; it may shadow the file store",
      error,
    );
  }
}

export function createLocalCredentialStore(options: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
} = {}): WritableCredentialStore {
  const env = options.env ?? process.env;
  const home = options.homedir ?? homedir();
  return createKeyringCredentialStore({
    fallback: createFileCredentialStore({ env, homedir: home }),
  });
}

function logStoreError(prefix: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`${prefix}: ${detail}`);
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory()) {
      return;
    }
    await chmod(path, mode);
  } catch {
    // chmod is best-effort (Windows, some FS).
  }
}
