/**
 * Read-only credential diagnosis: **which** stored session do the tools actually use?
 *
 * Two stores exist and `getCookie()` prefers the OS keychain:
 *
 *   ~/.config/icourse163-mcp/session   (0600 file, only written when the keychain fails)
 *   keychain: service icourse163.mcp / account cookie
 *
 * On Windows the keychain cannot hold a full cookie: a credential blob is capped at 2560
 * bytes and `@napi-rs/keyring` stores the password as UTF-16, so anything past 1280 ASCII
 * characters is rejected. Writes therefore land in the file — and any *older*, shorter
 * cookie left in the keychain keeps winning the read. The symptom is not an error:
 * `login` prints LOGIN_OK while every catalog tool sees an empty account, which
 * `session_status` then reports as a stale session.
 *
 * This command exists because that state is invisible from the outside. It prints lengths
 * and fingerprints only — never a cookie value, token, or password.
 *
 * Usage: npm run check:creds
 * Exit code: 0 healthy, 1 shadowed (two different values, keychain wins), 2 no session.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { cookieHasNtesstudysi, cookieHasStudyInfo, parseCookiePairs } from "./cookie";
import {
  createFileCredentialStore,
  createKeyringCredentialStore,
  createLocalCredentialStore,
  defaultSessionFilePath,
  KEYCHAIN_MAX_CREDENTIAL_BYTES,
} from "./credentials";

type Snapshot = {
  present: boolean;
  chars: number;
  utf16Bytes: number;
  fitsKeychain: boolean;
  fingerprint: string;
  tokenFingerprint: string;
  cookieCount: number;
  hasApiToken: boolean;
  hasWebSession: boolean;
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function describe(cookie: string | null): Snapshot {
  if (cookie == null || cookie.trim() === "") {
    return {
      present: false,
      chars: 0,
      utf16Bytes: 0,
      fitsKeychain: false,
      fingerprint: "-",
      tokenFingerprint: "-",
      cookieCount: 0,
      hasApiToken: false,
      hasWebSession: false,
    };
  }
  const jar = parseCookiePairs(cookie);
  const token = (jar.get("NTESSTUDYSI") ?? "").trim();
  const utf16Bytes = Buffer.byteLength(cookie, "utf16le");
  return {
    present: true,
    chars: cookie.length,
    utf16Bytes,
    fitsKeychain: utf16Bytes <= KEYCHAIN_MAX_CREDENTIAL_BYTES,
    fingerprint: fingerprint(cookie),
    tokenFingerprint: token.length === 0 ? "-" : fingerprint(token).slice(0, 8),
    cookieCount: jar.size,
    hasApiToken: cookieHasNtesstudysi(cookie),
    hasWebSession: cookieHasStudyInfo(cookie),
  };
}

function format(label: string, snapshot: Snapshot): string {
  if (!snapshot.present) {
    return `${label.padEnd(9)}: (empty)`;
  }
  const fit = snapshot.fitsKeychain ? "fits" : `over ${KEYCHAIN_MAX_CREDENTIAL_BYTES}B limit`;
  return (
    `${label.padEnd(9)}: ${String(snapshot.chars).padStart(5)} chars  ` +
    `${String(snapshot.utf16Bytes).padStart(5)} UTF-16 B (${fit})  ` +
    `sha ${snapshot.fingerprint}  token #${snapshot.tokenFingerprint}  ` +
    `${snapshot.cookieCount} cookies  api=${snapshot.hasApiToken ? "y" : "n"} web=${snapshot.hasWebSession ? "y" : "n"}`
  );
}

async function main(): Promise<void> {
  const file = createFileCredentialStore({ env: process.env, homedir: homedir() });
  // No fallback: this store must report the keychain alone, not "whatever getCookie() wins".
  const keychain = createKeyringCredentialStore();
  const effectiveStore = createLocalCredentialStore({ env: process.env, homedir: homedir() });

  const [fromFile, fromKeychain, effective] = await Promise.all([
    file.getCookie(),
    keychain.getCookie(),
    effectiveStore.getCookie(),
  ]);

  const fileView = describe(fromFile);
  const keychainView = describe(fromKeychain);
  const effectiveView = describe(effective);

  console.log("icourse163 credential check");
  console.log("===========================");
  console.log(format("keychain", keychainView));
  console.log(format("file", fileView));
  console.log(`         path ${defaultSessionFilePath(process.env, homedir())}`);
  console.log(format("effective", effectiveView));

  const source =
    !effectiveView.present
      ? "none"
      : effectiveView.fingerprint === keychainView.fingerprint
        ? "keychain (getCookie prefers it)"
        : effectiveView.fingerprint === fileView.fingerprint
          ? "file"
          : "unknown";
  console.log(`         store in effect: ${source}`);
  console.log(
    `         keychain limit: ${KEYCHAIN_MAX_CREDENTIAL_BYTES} bytes as UTF-16 ` +
      `(a full session is ~1700-2900 chars, so it never fits)`,
  );

  const shadowed =
    keychainView.present && fileView.present && keychainView.fingerprint !== fileView.fingerprint;

  if (shadowed) {
    console.log("");
    console.log("verdict  : SHADOWED");
    console.log("           The keychain holds a different cookie than the file, and the keychain wins.");
    console.log("           `login` can keep reporting success while the tools read the old session");
    console.log("           (symptom: LOGIN_OK but 0 courses / auth_expired).");
    console.log("           Fix: npm run login --clear   then   npm run login");
    process.exitCode = 1;
    return;
  }

  if (!effectiveView.present) {
    console.log("");
    console.log("verdict  : NO SESSION — run `npm run login` (or the MCP `login` tool).");
    process.exitCode = 2;
    return;
  }

  console.log("");
  console.log("verdict  : OK — one value, and the store that serves it is consistent.");
  if (!effectiveView.hasWebSession) {
    console.log("note     : STUDY_INFO is missing, so the Playwright path is unlikely to work.");
  }
  if (!effectiveView.fitsKeychain) {
    console.log("note     : the session is too large for the keychain, so it lives in the file.");
    console.log("           That is expected; it only becomes a problem if a stale keychain value reappears.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
