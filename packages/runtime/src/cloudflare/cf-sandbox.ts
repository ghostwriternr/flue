/**
 * The Cloudflare sandbox adapter. `cloudflareSandbox(settings)` defines a
 * kind of sandbox; the app exports the definition from `cloudflare.ts`, and
 * agents attach to sandboxes of it by id. Each sandbox is a `FlueSandbox`
 * Durable Object named `<definition>:<id>`, which owns the container and
 * its lifecycle; this side only forwards calls over Durable Object RPC, so
 * it never imports `cloudflare:workers` or `@cloudflare/sandbox`.
 */
import { SandboxDiedError } from '../errors.ts';
import { normalizePath, type SandboxDriver, sandboxFromDriver } from '../sandbox.ts';
import type { Sandbox, SandboxFactory } from '../types.ts';
import {
	type CloudflareSandboxOptions,
	type CloudflareSandboxStub,
	isCloudflareSandboxStub,
	legacyCloudflareSandbox,
} from './cf-sandbox-legacy.ts';
import { getCloudflareContext } from './context.ts';
import {
	type BrandedDefinition,
	type CloudflareSandboxSettingsInput,
	type CloudflareSandboxSnapshot,
	type CloudflareSandboxStatus,
	DEFINITION,
	type DefinitionInternals,
	FLUE_SANDBOX_BINDING,
	FLUE_SANDBOX_CLASS_NAME,
	type FlueSandboxRpc,
	parseSandboxDied,
	validateSettings,
} from './flue-sandbox-protocol.ts';

/** How an agent attaches to a sandbox of a definition. */
export interface CloudflareSandboxAttachOptions {
	/** Sandbox id. Agents that use the same id share one sandbox. Default: the agent instance id. */
	id?: string;
	/** Working directory, created on every container start. Default `/workspace`. */
	cwd?: string;
	/**
	 * Extra environment for every command from this agent, layered over the
	 * baseline (`HOME`, `LANG`, `TERM`, `PATH`). Image `ENV` lines don't
	 * apply to commands; set variables here. Not for secrets: every
	 * process in the container can read them.
	 */
	env?: Record<string, string>;
}

/**
 * A kind of Cloudflare sandbox, from {@link cloudflareSandbox}. Export it
 * from `cloudflare.ts`: its export name, with the sandbox id, identifies
 * each sandbox, so renaming the export starts new sandboxes.
 *
 * Pass it to `useSandbox()` for a sandbox per agent instance, or attach
 * with options for a shared id, another working directory, or command
 * environment.
 */
export interface CloudflareSandboxDefinition extends SandboxFactory {
	/** A sandbox factory with attachment options. */
	attach(options: CloudflareSandboxAttachOptions): SandboxFactory;
	/** A sandbox of this definition by id, from anywhere in the Worker (for example an admin route). */
	get(env: object, id: string): CloudflareSandboxHandle;
}

/**
 * Building blocks for managing one Cloudflare sandbox, from
 * {@link getCloudflareSandbox} or {@link CloudflareSandboxDefinition.get}.
 */
export interface CloudflareSandboxHandle {
	readonly id: string;
	/** Running state, workspace generation, and the snapshot the next start restores from. Throws when the sandbox does not exist. */
	status(): Promise<CloudflareSandboxStatus>;
	/** Take a snapshot now and make it the one the next start restores from. */
	checkpoint(): Promise<CloudflareSandboxSnapshot>;
	/**
	 * Destroy the container and forget its snapshot: the next use starts a
	 * fresh workspace from the image. Running commands fail with
	 * `SandboxDiedError` (`reason: 'reset'`).
	 */
	reset(): Promise<void>;
	/**
	 * Send an HTTP request to a TCP port in the container (for previews).
	 * Starts the container if needed; the server must already be listening.
	 */
	fetch(port: number, request: Request): Promise<Response>;
}

/**
 * Define a kind of sandbox on Cloudflare Containers, run by `FlueSandbox`.
 * Export it from `cloudflare.ts`, then use it in agents:
 *
 * ```ts
 * // cloudflare.ts
 * export const workspace = cloudflareSandbox();
 *
 * // agents/coder.ts
 * export function Coder() {
 *   useSandbox(workspace);
 *   return '…';
 * }
 * ```
 *
 * Settings may be a function of the sandbox id and the Worker `env`. Flue
 * reads them from code on every container start, so a deploy that changes
 * them reaches existing sandboxes.
 *
 * Requires a `containers` entry for `FlueSandbox` (with
 * `scheduling_policy: "durable_object"`) and a migration adding it to
 * `new_sqlite_classes`; `flueWorkerConfig()` adds the binding.
 */
export function cloudflareSandbox(
	settings?: CloudflareSandboxSettingsInput,
): CloudflareSandboxDefinition;
/**
 * @deprecated Wraps a `@cloudflare/sandbox` 0.x `Sandbox` Durable Object
 * stub, which Sandbox SDK 1.0 removed. Export a definition from
 * `cloudflareSandbox(settings)` instead. Removed in Flue 3.0.
 */
export function cloudflareSandbox(
	sandbox: CloudflareSandboxStub,
	options?: CloudflareSandboxOptions,
): SandboxFactory;
export function cloudflareSandbox(
	settingsOrStub: CloudflareSandboxSettingsInput | CloudflareSandboxStub = {},
	legacyOptions?: CloudflareSandboxOptions,
): SandboxFactory {
	if (isCloudflareSandboxStub(settingsOrStub)) {
		warnLegacyOnce();
		return legacyCloudflareSandbox(settingsOrStub, legacyOptions);
	}
	const settings = settingsOrStub;
	// Static settings fail where they are written; a settings function is
	// checked when a sandbox starts.
	if (typeof settings !== 'function') validateSettings(settings);
	const internals: DefinitionInternals = { settings };
	const attach = (options: CloudflareSandboxAttachOptions): SandboxFactory => {
		const checked = validateAttachOptions(options);
		return { createSandbox: ({ id }) => attachSandbox(internals, checked, id) };
	};
	const definition: CloudflareSandboxDefinition & BrandedDefinition = {
		[DEFINITION]: internals,
		createSandbox: ({ id }) => attachSandbox(internals, {}, id),
		attach,
		get: (env, id) => createHandle(env, definitionName(internals), id),
	};
	return definition;
}

/**
 * The sandbox an agent runs on, from its `harness.sandbox`. Throws when the
 * agent runs on a different sandbox, or when a `useSandbox(..., { cwd })`
 * override wrapped it (attach with `cwd` instead).
 */
export function getCloudflareSandbox(sandbox: Sandbox): CloudflareSandboxHandle {
	const handle = (sandbox as { [HANDLE]?: unknown })[HANDLE];
	if (!handle) {
		throw new Error(
			'[flue] getCloudflareSandbox(harness.sandbox) requires a cloudflareSandbox() sandbox. ' +
				'This agent runs on a different sandbox, or a useSandbox(..., { cwd }) override wrapped it; ' +
				'attach with `cwd` instead. To look a sandbox up by id, call get(env, id) on its definition.',
		);
	}
	return handle as CloudflareSandboxHandle;
}

// ─── Internals ──────────────────────────────────────────────────────────────

const HANDLE = Symbol.for('@flue/runtime/cloudflare-sandbox');

/** How long an aborted command may take to settle after its process group is killed. */
const KILL_GRACE_MS = 5_000;

const ATTACH_KEYS = new Set(['id', 'cwd', 'env']);

let legacyWarned = false;

function warnLegacyOnce(): void {
	if (legacyWarned) return;
	legacyWarned = true;
	console.warn(
		'[flue] cloudflareSandbox(getSandbox(...)) wraps the @cloudflare/sandbox 0.x Sandbox Durable Object, ' +
			'which Sandbox SDK 1.0 removed. This path is deprecated and will be removed in Flue 3.0. ' +
			'Migrate to an exported cloudflareSandbox() definition: run `flue update sandbox cloudflare` ' +
			'and follow its version 2 upgrade guide.',
	);
}

function validateAttachOptions(
	options: CloudflareSandboxAttachOptions,
): CloudflareSandboxAttachOptions {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new Error('[flue] attach() expects an options object.');
	}
	for (const key of Object.keys(options)) {
		if (ATTACH_KEYS.has(key)) continue;
		throw new Error(
			`[flue] attach() received unknown option "${key}". Attach takes id, cwd, and env; ` +
				'settings belong in the cloudflareSandbox() definition.',
		);
	}
	if (options.id !== undefined && (typeof options.id !== 'string' || options.id === '')) {
		throw new Error('[flue] attach() id must be a non-empty string.');
	}
	if (options.cwd !== undefined && !options.cwd.startsWith('/')) {
		throw new Error(`[flue] attach() cwd must be an absolute path, got "${options.cwd}".`);
	}
	return options;
}

/** The definition's export name, recorded when the Worker loaded `cloudflare.ts`. */
function definitionName(internals: DefinitionInternals): string {
	if (internals.name !== undefined) return internals.name;
	throw new Error(
		'[flue] This cloudflareSandbox() definition is not exported from cloudflare.ts. Export it there: ' +
			'its export name identifies its sandboxes, so it has to be stable and known to the Worker.',
	);
}

function sandboxStub(env: object, definition: string, id: string): FlueSandboxRpc {
	const namespace = (env as Record<string, unknown>)[FLUE_SANDBOX_BINDING] as
		{ getByName(name: string): unknown } | undefined;
	if (typeof namespace?.getByName !== 'function') {
		throw new Error(
			`[flue] cloudflareSandbox() needs the ${FLUE_SANDBOX_CLASS_NAME} Durable Object. Add a "containers" entry ` +
				`with "class_name": "${FLUE_SANDBOX_CLASS_NAME}" and "scheduling_policy": "durable_object" to your wrangler config, ` +
				`plus a migration with "new_sqlite_classes": ["${FLUE_SANDBOX_CLASS_NAME}"]. flueWorkerConfig() then adds the ` +
				`${FLUE_SANDBOX_BINDING} binding.`,
		);
	}
	if (typeof id !== 'string' || id.length === 0) {
		throw new Error('[flue] A Cloudflare sandbox id must be a non-empty string.');
	}
	// Export names never contain ":", so the first one separates the parts.
	return namespace.getByName(`${definition}:${id}`) as FlueSandboxRpc;
}

function createHandle(env: object, definition: string, id: string): CloudflareSandboxHandle {
	const stub = sandboxStub(env, definition, id);
	return {
		id,
		status: () => stub.status(),
		checkpoint: () => call('checkpoint', stub.checkpoint()),
		reset: () => stub.reset(),
		fetch: (port, request) => call('fetch', stub.fetchPort(port, request)),
	};
}

/** Await a `FlueSandbox` RPC call, rebuilding `SandboxDiedError` from its RPC-safe tag. */
async function call<T>(operation: string, reply: Promise<T>): Promise<T> {
	try {
		return await reply;
	} catch (error) {
		const reason = parseSandboxDied(error);
		if (reason) throw new SandboxDiedError({ operation, reason });
		throw error;
	}
}

async function attachSandbox(
	internals: DefinitionInternals,
	options: CloudflareSandboxAttachOptions,
	instanceId: string,
): Promise<Sandbox> {
	const { id = instanceId, cwd: requestedCwd = '/workspace', env = {} } = options;
	const workerEnv = getCloudflareContext().env;
	const name = definitionName(internals);
	const stub = sandboxStub(workerEnv, name, id);
	const cwd = normalizePath(requestedCwd);
	await call('start', stub.ensure(name, id, cwd));
	const sandbox: Sandbox & { [HANDLE]: CloudflareSandboxHandle } = {
		...sandboxFromDriver(rpcDriver(stub, cwd, env), cwd, { cancelGraceMs: KILL_GRACE_MS }),
		async workspaceNotice(scope) {
			// Ask every time: another agent sharing the sandbox, or a crash,
			// can change the workspace without any call from this agent.
			const notice = await stub.notice(scope);
			if (!notice) return undefined;
			return {
				text: notice.text,
				acknowledge: () => stub.acknowledgeNotice(scope, notice.generation),
			};
		},
		[HANDLE]: createHandle(workerEnv, name, id),
	};
	return sandbox;
}

/** The `FlueSandbox` RPC surface as a {@link SandboxDriver}: paths arrive absolute. */
function rpcDriver(stub: FlueSandboxRpc, cwd: string, env: Record<string, string>): SandboxDriver {
	const readFileBuffer = (path: string) => call('readFile', stub.readFile(path));
	return {
		async exec(command, options) {
			// Abort kills the command's process group; sandboxFromDriver waits
			// (up to KILL_GRACE_MS) for this call to settle before releasing
			// the caller, so the next call never races a still-running command.
			const cmdId = crypto.randomUUID();
			const signal = options?.signal;
			const onAbort = (): void => void stub.kill(cmdId).catch(() => {});
			signal?.addEventListener('abort', onAbort, { once: true });
			try {
				return await call(
					'exec',
					stub.run(cmdId, command, {
						cwd: options?.cwd ?? cwd,
						env: { ...env, ...options?.env },
						...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
					}),
				);
			} finally {
				signal?.removeEventListener('abort', onAbort);
			}
		},
		readFileBuffer,
		readFile: async (path) => new TextDecoder().decode(await readFileBuffer(path)),
		writeFile: (path, content) =>
			call(
				'writeFile',
				stub.writeFile(
					path,
					typeof content === 'string' ? new TextEncoder().encode(content) : content,
				),
			),
		async stat(path) {
			const { mtimeMs, ...stat } = await call('stat', stub.stat(path));
			return { ...stat, mtime: new Date(mtimeMs) };
		},
		readdir: (path) => call('readdir', stub.readdir(path)),
		exists: (path) => call('exists', stub.exists(path)),
		mkdir: (path, options) => call('mkdir', stub.mkdir(path, options?.recursive ?? false)),
		rm: (path, options) =>
			call('rm', stub.rm(path, options?.recursive ?? false, options?.force ?? false)),
	};
}
