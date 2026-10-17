/**
 * The application only relies on this small Redis command surface. Keeping it
 * structural makes the durable components straightforward to exercise with an
 * offline fake and avoids coupling the HTTP layer to ioredis internals.
 */
export interface RedisClientLike {
  status?: string;
  connect?: () => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string, ...args: Array<string | number>) => Promise<unknown>;
  del?: (...keys: string[]) => Promise<number>;
  sadd?: (key: string, ...members: string[]) => Promise<number>;
  srem?: (key: string, ...members: string[]) => Promise<number>;
  smembers?: (key: string) => Promise<string[]>;
  eval?: (script: string, numberOfKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  xadd?: (stream: string, id: string, ...fieldValues: string[]) => Promise<string>;
  xgroup?: (...args: string[]) => Promise<unknown>;
  xreadgroup?: (...args: Array<string | number>) => Promise<unknown>;
  xack?: (stream: string, group: string, ...ids: string[]) => Promise<number>;
  xlen?: (stream: string) => Promise<number>;
  xpending?: (...args: Array<string | number>) => Promise<unknown>;
}

export async function connectRedis(client: RedisClientLike): Promise<void> {
  if (!client.connect || client.status === 'ready' || client.status === 'connecting') return;
  await client.connect().catch((error: unknown) => {
    if (!(error instanceof Error) || !/already/i.test(error.message)) throw error;
  });
}

export async function closeRedis(client: RedisClientLike, ownsClient: boolean): Promise<void> {
  if (!ownsClient) return;
  if (client.quit) {
    await client.quit().catch(() => undefined);
    return;
  }
  client.disconnect?.();
}

export function requireRedisCommand<K extends keyof RedisClientLike>(
  client: RedisClientLike,
  command: K,
): NonNullable<RedisClientLike[K]> {
  const method = client[command];
  if (typeof method !== 'function') throw new Error(`Redis client does not implement ${String(command)}.`);
  const callable = method as unknown as (...args: unknown[]) => unknown;
  return callable.bind(client) as NonNullable<RedisClientLike[K]>;
}
