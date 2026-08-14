/**
 * NestJS: a provider with `useFactory`, where a `ConfigService` would be.
 *
 * Typechecked in CI rather than run — a Nest application needs decorators,
 * `reflect-metadata` and a compile step, and an example that installs a
 * framework to print one line is a test of npm rather than of this
 * binding. What it shows is the wiring, which is the part that is
 * different from every other framework: Nest asks for a *provider*, and a
 * configuration object is one.
 *
 *   npm install @nestjs/common @nestjs/core reflect-metadata
 *   npx tsc --noEmit examples/10-nestjs/config.module.ts
 */

import { DynamicConfig } from "dynamic-config-node";

export interface Database {
  host: string;
  port: number;
}

/** The token a service injects. A string, because the value is generic. */
export const DATABASE_CONFIG = "DATABASE_CONFIG";

/**
 * One provider, one factory, one instance for the application's lifetime.
 *
 * `useFactory` is `async`, which is exactly what `init()` is — so the
 * application does not start until the configuration has loaded and
 * validated, and a broken file is a startup failure with a message rather
 * than a service that answers wrongly.
 */
export const databaseConfigProvider = {
  provide: DATABASE_CONFIG,
  useFactory: async (): Promise<DynamicConfig<Database>> => {
    const config = new DynamicConfig<Database>({
      key: "db",
      validate: (document): Database => {
        const record = document as Record<string, unknown>;

        if (typeof record.host !== "string") {
          throw new Error("host must be a string");
        }

        return { host: record.host, port: Number(record.port ?? 5432) };
      },
      fields: ["host", "port"],
    });

    await config.file("config.toml").env("APP_").init();

    // The watcher belongs to the provider, so it lives exactly as long as
    // the application does — and `onModuleDestroy` is where a Nest
    // application stops it.
    config.watch({ debounceMs: 250 });

    return config;
  },
};

/**
 * What a service then writes.
 *
 * Note what it does *not* do: it holds the configuration object, not the
 * values. Injecting `config.current()` would inject the document that was
 * in force when the application started, which is a configuration that has
 * stopped reloading — the mistake this whole library exists to make
 * impossible, reintroduced in one line of dependency injection.
 */
export class QueryService {
  constructor(private readonly config: DynamicConfig<Database>) {}

  connectionString(): string {
    const { host, port } = this.config.current();

    return `postgres://${host}:${port}`;
  }
}
