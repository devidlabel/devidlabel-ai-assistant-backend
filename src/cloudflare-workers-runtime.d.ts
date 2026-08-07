declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: {
      storage: {
        get<T = unknown>(key: string): Promise<T | undefined>;
        put(key: string, value: unknown): Promise<void>;
        transaction<T>(callback: (txn: {
          get<U = unknown>(key: string): Promise<U | undefined>;
          put(key: string, value: unknown): Promise<void>;
        }) => Promise<T>): Promise<T>;
      };
    };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
