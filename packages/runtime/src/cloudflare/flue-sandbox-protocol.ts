/**
 * Shared vocabulary between the Cloudflare sandbox adapter (running in an
 * agent's Durable Object) and `FlueSandbox`, the Durable Object that owns
 * the container. Free of `cloudflare:workers` runtime imports, which the
 * adapter side must not pull in.
 */

/** Class name of the Flue-owned Durable Object that runs Cloudflare sandboxes. */
export const FLUE_SANDBOX_CLASS_NAME = 'FlueSandbox';

/** Durable Object binding `flueWorkerConfig()` adds for `FlueSandbox`. */
export const FLUE_SANDBOX_BINDING = 'FLUE_SANDBOX';

/** Default idle period before Flue snapshots and stops a container. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Longest idle period: the platform inactivity timeout (6 hours max) trails it by 5 minutes. */
const MAX_IDLE_TIMEOUT_MS = 6 * 60 * 60_000 - 5 * 60_000;

/** Container size: a named instance type or custom resources. */
export type CloudflareSandboxInstance =
	| 'lite'
	| 'standard-1'
	| 'standard-2'
	| 'standard-3'
	| 'standard-4'
	| { vcpu: number; memoryMib: number; diskMb: number };

/**
 * One outbound intercept, applied to the container on every start: requests
 * to `host` (HTTPS too with `https: true`), or all outbound HTTP, go to
 * `target`. The target is usually an exported `WorkerEntrypoint` from the
 * settings function's `exports` (`exports.GitHubProxy({ props })`), or a
 * service binding from its `env`.
 */
export type CloudflareSandboxIntercept =
	{ host: string; https?: boolean; target: Fetcher } | { all: true; target: Fetcher };

/** A root-filesystem snapshot of a sandbox's workspace. */
export interface CloudflareSandboxSnapshot {
	/** Platform snapshot id. */
	readonly id: string;
	/** Size in bytes of the difference from the image. */
	readonly size: number;
	/** When the snapshot was taken (ISO 8601). */
	readonly createdAt: string;
}

/** The sandbox a definition's settings are resolved for. */
export interface CloudflareSandboxContext {
	/** Sandbox id. */
	readonly id: string;
	/** The Worker's `env` (typed by `wrangler types`). */
	readonly env: Cloudflare.Env;
	/** The Worker's exports (`ctx.exports`), for intercept targets. */
	readonly exports: Cloudflare.Exports;
}

/**
 * How a sandbox definition's containers run. Flue reads these from code on
 * every start, so a deploy that changes them reaches existing sandboxes:
 * intercepts and the idle timeout at once, the instance type and internet
 * access at the next start, `persist` at the next idle stop, and the image
 * the next time the sandbox boots from it (a persisted workspace keeps the
 * image its snapshot was taken from until `reset()`).
 */
export interface CloudflareSandboxSettings {
	/** Key in the container entry's `images` map, or a full image reference. Default: the only configured image, else `cloudflare/debian-trixie`. */
	image?: string;
	/** Container size. Default `'standard-1'`; `'lite'` makes each command take most of a second. */
	instance?: CloudflareSandboxInstance;
	/** Allow outbound internet access. Default `true`. */
	enableInternet?: boolean;
	/** Keep the workspace across idle stops through snapshots. Default `true`; `false` discards it at each stop. */
	persist?: boolean;
	/** Idle period before Flue stops the container. Default 10 minutes. */
	idleTimeoutMs?: number;
	/** Outbound intercepts applied on every container start. */
	intercepts?: readonly CloudflareSandboxIntercept[];
	/**
	 * Runs on every container start, after Flue prepared the container and
	 * applied the intercepts, before any command. Use it for setup that
	 * intercepts cannot express, such as a background process that should
	 * run whenever the container does. Throwing fails the start.
	 */
	onStart?(container: Container, sandbox: CloudflareSandboxContext): Promise<void> | void;
}

/** Settings, or a function of the sandbox that returns them. */
export type CloudflareSandboxSettingsInput =
	CloudflareSandboxSettings | ((sandbox: CloudflareSandboxContext) => CloudflareSandboxSettings);

/**
 * Marks a sandbox definition and holds what `FlueSandbox` needs from it.
 * The export name of the definition in `cloudflare.ts` is its durable
 * identity; Flue records it when the Worker loads.
 */
export const DEFINITION = Symbol.for('@flue/runtime/cloudflare-sandbox-definition');

export interface DefinitionInternals {
	readonly settings: CloudflareSandboxSettingsInput;
	/** Export name in `cloudflare.ts`, recorded when the Worker loads. */
	name?: string;
}

export interface BrandedDefinition {
	readonly [DEFINITION]: DefinitionInternals;
}

export function isSandboxDefinition(value: unknown): value is BrandedDefinition {
	return typeof value === 'object' && value !== null && DEFINITION in value;
}

const SETTING_KEYS = new Set([
	'image',
	'instance',
	'enableInternet',
	'persist',
	'idleTimeoutMs',
	'intercepts',
	'onStart',
]);

const INSTANCE_TYPES = new Set(['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']);

/** Attachment options people put in settings by mistake, with where they go instead. */
const MISPLACED_KEYS: Record<string, string> = {
	id: 'pass it when attaching: definition.attach({ id })',
	cwd: 'pass it when attaching: definition.attach({ cwd })',
	env: 'pass it when attaching: definition.attach({ env })',
	sleepAfter: 'use idleTimeoutMs',
	keepAlive: 'use a longer idleTimeoutMs',
};

/**
 * Check a definition's settings, throwing on the first problem. `name` is
 * the definition's export name once known, for error messages.
 */
export function validateSettings(settings: unknown, name?: string): CloudflareSandboxSettings {
	const label =
		name === undefined ? 'cloudflareSandbox()' : `cloudflareSandbox() definition "${name}"`;
	const fail = (problem: string): never => {
		throw new Error(`[flue] ${label}: ${problem}.`);
	};
	if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
		return fail('settings must be an object');
	}
	const record = settings as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (SETTING_KEYS.has(key)) continue;
		const hint = MISPLACED_KEYS[key];
		fail(hint ? `"${key}" is not a setting; ${hint}` : `unknown setting "${key}"`);
	}
	const { image, instance, enableInternet, persist, idleTimeoutMs, intercepts, onStart } = record;
	if (image !== undefined && (typeof image !== 'string' || image === '')) {
		fail('image must be a non-empty string');
	}
	if (instance !== undefined && !isInstance(instance)) {
		fail("instance must be 'lite', 'standard-1' to 'standard-4', or { vcpu, memoryMib, diskMb }");
	}
	for (const [key, value] of [
		['enableInternet', enableInternet],
		['persist', persist],
	] as const) {
		if (value !== undefined && typeof value !== 'boolean') fail(`${key} must be a boolean`);
	}
	if (
		idleTimeoutMs !== undefined &&
		(typeof idleTimeoutMs !== 'number' ||
			!Number.isInteger(idleTimeoutMs) ||
			idleTimeoutMs <= 0 ||
			idleTimeoutMs > MAX_IDLE_TIMEOUT_MS)
	) {
		fail(`idleTimeoutMs must be a whole number between 1 and ${MAX_IDLE_TIMEOUT_MS}`);
	}
	if (intercepts !== undefined) {
		if (!Array.isArray(intercepts)) fail('intercepts must be an array');
		for (const intercept of intercepts as unknown[]) {
			if (!isIntercept(intercept)) {
				fail(
					'each intercept needs `host` (with optional `https`) or `all: true`, and a `target` Fetcher such as exports.MyProxy({ props })',
				);
			}
		}
	}
	if (onStart !== undefined && typeof onStart !== 'function') fail('onStart must be a function');
	return record as CloudflareSandboxSettings;
}

function isInstance(value: unknown): value is CloudflareSandboxInstance {
	if (typeof value === 'string') return INSTANCE_TYPES.has(value);
	if (typeof value !== 'object' || value === null) return false;
	const { vcpu, memoryMib, diskMb } = value as Record<string, unknown>;
	return [vcpu, memoryMib, diskMb].every((n) => typeof n === 'number' && n > 0);
}

function isIntercept(value: unknown): value is CloudflareSandboxIntercept {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	const matcher =
		(typeof v.host === 'string' && v.host !== '' && v.all === undefined) ||
		(v.all === true && v.host === undefined && v.https === undefined);
	const target = v.target as { fetch?: unknown } | undefined;
	return (
		matcher &&
		typeof target?.fetch === 'function' &&
		(v.https === undefined || typeof v.https === 'boolean')
	);
}

/** Why the workspace was replaced the last time its generation changed. */
export type CloudflareWorkspaceChange =
	{ reason: 'restored'; at: string; snapshotCreatedAt: string } | { reason: 'reset'; at: string };

export interface CloudflareSandboxStatus {
	readonly id: string;
	/** Export name of the sandbox's definition in `cloudflare.ts`. */
	readonly definition: string;
	/** Whether a container is running for this sandbox right now. */
	readonly running: boolean;
	/** Increments each time the workspace is restored or reset underneath its users. */
	readonly generation: number;
	readonly lastChange?: CloudflareWorkspaceChange;
	/** The snapshot the next start restores from, if any. */
	readonly snapshot?: CloudflareSandboxSnapshot;
	readonly createdAt: string;
}

/** Result of one command. */
export interface RpcShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RpcFileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	size: number;
	mtimeMs: number;
}

export interface RpcRunOptions {
	/** Absolute working directory. */
	cwd: string;
	/** Environment layered over the baseline (agent env, then per-call env). */
	env: Record<string, string>;
	timeoutMs?: number;
}

/** A workspace notice `FlueSandbox` returns until the observer acknowledges its generation. */
export interface RpcNotice {
	readonly generation: number;
	readonly text: string;
}

/**
 * Errors lose their class across Durable Object RPC, so `FlueSandbox` tags a
 * sandbox death in the message and the adapter rebuilds `SandboxDiedError`.
 */
const SANDBOX_DIED_TAG = '[flue:sandbox_died:';

export function sandboxDiedMessage(operation: string, reason: 'stopped' | 'reset'): string {
	return `${SANDBOX_DIED_TAG}${reason}] Sandbox ${operation} failed: the container ${reason === 'reset' ? 'was reset' : 'stopped'} while the call was in flight.`;
}

export function parseSandboxDied(error: unknown): 'stopped' | 'reset' | undefined {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const start = message.indexOf(SANDBOX_DIED_TAG);
	if (start === -1) return undefined;
	const reason = message.slice(start + SANDBOX_DIED_TAG.length).split(']')[0];
	return reason === 'reset' ? 'reset' : 'stopped';
}

/** The `FlueSandbox` RPC surface, as the adapter and the public handle call it. */
export interface FlueSandboxRpc {
	ensure(definition: string, id: string, cwd: string): Promise<void>;
	run(cmdId: string, command: string, options: RpcRunOptions): Promise<RpcShellResult>;
	kill(cmdId: string): Promise<void>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	stat(path: string): Promise<RpcFileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, recursive: boolean): Promise<void>;
	rm(path: string, recursive: boolean, force: boolean): Promise<void>;
	/** The pending workspace notice for an observer, if any; acknowledge it after delivery. */
	notice(scope: string): Promise<RpcNotice | undefined>;
	acknowledgeNotice(scope: string, generation: number): Promise<void>;
	status(): Promise<CloudflareSandboxStatus>;
	checkpoint(): Promise<CloudflareSandboxSnapshot>;
	reset(): Promise<void>;
	fetchPort(port: number, request: Request): Promise<Response>;
}
