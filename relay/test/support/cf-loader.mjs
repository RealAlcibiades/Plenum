// Node module hook for the fake runtime suite: resolves the Workers-only module
// cloudflare:workers to a stand-in DurableObject base class.
const STUB = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
