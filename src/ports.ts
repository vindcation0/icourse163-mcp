import type { StudyPlaywrightRunner } from "./study-playwright";

export type CredentialStore = {
  getCookie(): Promise<string | null>;
};

export type Icourse163HttpRequest = {
  url: string;
  cookie: string;
  method?: "GET" | "POST";
  /** application/x-www-form-urlencoded body (mutually exclusive with json). */
  form?: Record<string, string>;
  /** application/json body (mutually exclusive with form). */
  json?: unknown;
  /**
   * Body sent verbatim. Required for signed RPCs: the signature covers the exact
   * bytes on the wire, so the transport must not re-serialize it. Pair with an
   * explicit content-type header.
   */
  raw?: string;
  headers?: Record<string, string>;
};

export type Icourse163HttpResponse = {
  statusCode: number;
  url: string;
  body: string;
  cookie: string;
};

export type Icourse163Http = {
  request(input: Icourse163HttpRequest): Promise<Icourse163HttpResponse>;
};

export type Icourse163Ports = {
  credentials: CredentialStore;
  http: Icourse163Http;
  /** Optional Playwright study runner (injectable for tests). */
  studyPlaywright?: StudyPlaywrightRunner;
};
