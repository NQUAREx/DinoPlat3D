import { createHandler } from './core.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve(createHandler({
  env: name => Deno.env.get(name),
  fetch: globalThis.fetch.bind(globalThis),
  background: promise => EdgeRuntime.waitUntil(promise),
}));
