/**
 * Internal Cloudflare runtime plumbing consumed by the generated Worker
 * entry point (the `@flue/vite` Cloudflare target).
 *
 * This subpath is NOT part of the public API. The authoring surface for
 * Cloudflare users lives at `@flue/runtime/cloudflare`; the Node/shared
 * generated-entry helpers live at `@flue/runtime/internal`.
 *
 * This entry only ever evaluates inside workerd, so real `cloudflare:workers`
 * imports live here — that is the point of the subpath, not a hazard to
 * engineer around. Evaluating it under Node (a test, a loader) fails on that
 * virtual module unless the test mocks it, and that friction is deliberate:
 * tests do not run in the deploy environment, and the mock is the reminder.
 * The constraint runs one direction only — nothing on this entry may be
 * imported from `@flue/runtime/internal` or any other Node-loadable entry,
 * which must stay evaluable without workerd.
 */
export { runWithCloudflareContext } from './context.ts';
export type { CreateFlueAgentClassOptions } from './flue-agent-class.ts';
export { createFlueAgentClass } from './flue-agent-class.ts';
export type { CreateFlueSandboxClassOptions } from './flue-sandbox-class.ts';
export { createFlueSandboxClass } from './flue-sandbox-class.ts';
export { installDefaultCloudflareTracing } from './tracing/index.ts';
export type {
	CloudflareAgentIdentity,
	CloudflareWorkerConfig,
	CreateCloudflareWorkerConfigOptions,
} from './worker-config.ts';
export { createCloudflareWorkerConfig } from './worker-config.ts';
