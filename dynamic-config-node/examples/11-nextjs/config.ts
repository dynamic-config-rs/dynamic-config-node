/**
 * Next.js: the server reads configuration; the client gets what the server
 * chose to send it.
 *
 * Typechecked in CI rather than run. What it carries is the boundary,
 * which is the one thing this binding must not blur: **there is no
 * configuration engine in the browser.** No filesystem, no watcher, no
 * store. What ships to a client is a snapshot somebody decided to send,
 * and deciding *which fields* is a security question, not a plumbing one.
 */

import { DynamicConfig } from "dynamic-config-node";

export interface AppConfig {
  /** Sent to the browser. */
  siteName: string;
  /** Sent to the browser. */
  features: { newCheckout: boolean };
  /** **Not** sent to the browser. */
  databaseUrl: string;
  /** **Not** sent to the browser. */
  stripeSecret: string;
}

/**
 * One instance per server process, not one per request.
 *
 * Next.js re-evaluates modules per route in development, so the instance
 * is parked on `globalThis` — the same trick a database pool needs there,
 * and for the same reason: a watcher per hot reload is a leak per hot
 * reload.
 */
const cached = globalThis as typeof globalThis & { __appConfig?: DynamicConfig<AppConfig> };

export async function appConfig(): Promise<DynamicConfig<AppConfig>> {
  if (cached.__appConfig) {
    return cached.__appConfig;
  }

  const config = new DynamicConfig<AppConfig>({
    key: "app",
    validate: (document): AppConfig => {
      const record = document as Record<string, unknown>;

      return {
        siteName: String(record.siteName ?? "example"),
        features: { newCheckout: Boolean((record.features as { newCheckout?: unknown })?.newCheckout) },
        databaseUrl: String(record.databaseUrl ?? ""),
        stripeSecret: String(record.stripeSecret ?? ""),
      };
    },
    // Declared, so a redacting cache and `explain` both know what must
    // never be printed.
    secrets: ["databaseUrl", "stripeSecret"],
    fields: ["siteName", "features", "databaseUrl", "stripeSecret"],
  });

  await config.file("config.toml").env("APP_").init();
  config.watch({ debounceMs: 250 });

  cached.__appConfig = config;

  return config;
}

/**
 * The half a browser may see, and it is written out field by field.
 *
 * Deliberately not `omit(secrets)`: a deny-list is a list somebody forgets
 * to add to, and the field they forget is the one that matters. An
 * allow-list fails the other way — a new public field is invisible until
 * somebody adds it here, which is a bug report rather than an incident.
 */
export interface PublicConfig {
  siteName: string;
  features: { newCheckout: boolean };
}

export function publicHalf(config: AppConfig): PublicConfig {
  return { siteName: config.siteName, features: { newCheckout: config.features.newCheckout } };
}
