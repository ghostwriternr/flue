/**
 * `FlueSandbox`: the Flue-owned Durable Object that owns one container and
 * its workspace per sandbox, named `<definition>:<sandbox id>`.
 *
 * Containers on the `durable_object` scheduling policy belong to a Durable
 * Object, and nothing else runs their lifecycle. `FlueSandbox` does:
 *
 * - start: from the workspace's snapshot when it has one, else its image;
 * - idle stop: when no client call or command is in flight for the idle
 *   period, snapshot the root filesystem (when the sandbox persists), then
 *   destroy the container;
 * - commands: every command runs as a record in its own process group
 *   (`flue-sandbox-commands.ts`), so it can be killed as a whole and
 *   outlives either Durable Object restarting;
 * - unexpected loss: restore the last snapshot (or start fresh) and bump
 *   the workspace generation, which agents surface to the model.
 *
 * Settings are code, not state: each instance resolves them from its
 * definition (exported from the app's `cloudflare.ts`) when it loads and
 * on every start, so a deploy reaches existing sandboxes. Storage holds
 * only the sandbox's identity and workspace state: attached working
 * directories, lifecycle phase, generation, and snapshot.
 *
 * Adapter-facing RPC methods are internal; the public surface is
 * `cloudflareSandbox()` in `cf-sandbox.ts`. Internals use `#private`
 * members because every public method of a Durable Object is callable
 * over RPC.
 *
 * This module imports `cloudflare:workers` and is only reachable from the
 * `@flue/runtime/cloudflare/internal` entry.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ExtensionClass } from './extension.ts';
import {
	BASELINE_ENV,
	type ExecResult,
	existsArgv,
	killArgv,
	mkdirArgv,
	parseReaddir,
	parseRun,
	parseStat,
	parseSweep,
	prepareArgv,
	RECORD_ID_IN_USE_EXIT,
	readdirArgv,
	readFileArgv,
	rmArgv,
	runArgv,
	statArgv,
	sweepArgv,
	writeFileArgv,
} from './flue-sandbox-commands.ts';
import {
	type CloudflareSandboxInstance,
	type CloudflareSandboxSnapshot,
	type CloudflareWorkspaceChange,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFINITION,
	type DefinitionInternals,
	FLUE_SANDBOX_CLASS_NAME,
	type FlueSandboxRpc,
	isSandboxDefinition,
	type RpcFileStat,
	type RpcNotice,
	type RpcRunOptions,
	type RpcShellResult,
	sandboxDiedMessage,
	validateSettings,
} from './flue-sandbox-protocol.ts';

/** The platform inactivity timeout trails Flue's idle stop by this much (see `MAX_IDLE_TIMEOUT_MS`); it is a backstop only. */
const BACKSTOP_MS = 5 * 60_000;
/** Supervision cadence while commands run or calls are in flight. */
const KEEPALIVE_MS = 30_000;
/** Retry delay after a failed idle stop. */
const STOP_RETRY_MS = 60_000;
/** Image for sandboxes on a container entry without `images`, and its main process. */
const DEFAULT_IMAGE = 'cloudflare/debian-trixie';
const DEFAULT_ENTRYPOINT = ['sleep', 'infinity'];

const STATE_KEY = 'flue:sandbox';
/** Time of the last client call. Stored because the Durable Object is evicted while its container idles. */
const ACTIVITY_KEY = 'flue:activity';
const SEEN_KEY_PREFIX = 'flue:seen:';

/**
 * Where the workspace's container lifecycle stands, which decides what the
 * next start boots from:
 *
 * - `stopped`: never started, or Flue stopped it (idle stop); boot from the
 *   current snapshot, else the image.
 * - `started`: Flue started it and has not stopped it; a container that is
 *   not running was lost, which the next start or notice check records as
 *   a workspace change before moving to `stopped`.
 *
 * A container still running outside `started` is left over from an idle
 * stop that saved its state but was evicted before it destroyed the
 * container; Flue destroys it rather than use it.
 */
type LifecyclePhase = 'started' | 'stopped';

interface SandboxState {
	/** Export name of the definition; with `id`, the sandbox's identity. */
	definition: string;
	id: string;
	createdAt: string;
	/** Working directories agents attached with; created on every start. */
	cwds: string[];
	phase: LifecyclePhase;
	generation: number;
	lastChange?: CloudflareWorkspaceChange;
	/** The snapshot the next start restores from. */
	snapshot?: CloudflareSandboxSnapshot;
}

/** A definition's settings with defaults applied and validated. */
interface ResolvedSettings {
	/** Image reference to boot; `undefined` means the default image. */
	image: string | undefined;
	instance: CloudflareSandboxInstance;
	enableInternet: boolean;
	persist: boolean;
	idleTimeoutMs: number;
}

/** Definitions exported from the app's `cloudflare.ts`, by export name. */
const definitions = new Map<string, DefinitionInternals>();

class FlueSandbox extends DurableObject<Record<string, unknown>> implements FlueSandboxRpc {
	#state: SandboxState | undefined;
	/** Resolved when needed and again at every start, which is when settings take effect. */
	#settings: ResolvedSettings | undefined;
	/** Client calls currently running (idle requires zero). */
	#inflight = 0;
	#lastActivity = Date.now();
	#starting: Promise<void> | undefined;
	#stopping: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			this.#state = await ctx.storage.get<SandboxState>(STATE_KEY);
			const stored = await ctx.storage.get<number>(ACTIVITY_KEY);
			if (stored !== undefined) this.#lastActivity = stored;
			else if (this.#state) await ctx.storage.put(ACTIVITY_KEY, this.#lastActivity);
			const container = ctx.container;
			if (!container?.running || this.#state?.phase !== 'started') return;
			// The platform inactivity timeout does not survive a Durable
			// Object restart: without re-arming it, a running container
			// stops shortly after the reload. Re-arm it for what is
			// left of the backstop, so evictions don't keep extending it.
			const left = this.#lastActivity + this.#inactivityMs() - Date.now();
			await container.setInactivityTimeout(Math.max(left, 3 * KEEPALIVE_MS));
			// A deploy may have shortened the idle timeout: supervise to the
			// new deadline, so Flue stops the container before the backstop.
			const deadline = this.#lastActivity + this.#supervision().idleTimeoutMs;
			const alarm = await ctx.storage.getAlarm();
			if (alarm === null || alarm > deadline) await ctx.storage.setAlarm(deadline);
		});
	}

	// ─── Adapter RPC (internal) ──────────────────────────────────────────

	/** Register an agent's attachment: create the sandbox on first use, add `cwd`, and start the container. */
	async ensure(definition: string, id: string, cwd: string): Promise<void> {
		if (!this.#state) {
			this.#state = newState(definition, id);
			try {
				// Fail on a misconfigured definition before the sandbox exists.
				this.#resolve();
			} catch (error) {
				this.#state = undefined;
				throw error;
			}
		}
		if (!this.#state.cwds.includes(cwd)) this.#state.cwds.push(cwd);
		await this.#save();
		await this.#op(() => this.#checked('start', cwd, mkdirArgv(cwd, true)));
	}

	async run(cmdId: string, command: string, options: RpcRunOptions): Promise<RpcShellResult> {
		return this.#op(async () => {
			const output = await this.#exec('exec', runArgv(cmdId, command, options));
			this.#assertAlive('exec');
			if (output.exitCode === RECORD_ID_IN_USE_EXIT) {
				throw new Error(`[flue] Sandbox command id "${cmdId}" is already in use.`);
			}
			const result = parseRun(output);
			if (!result) throw new Error(sandboxDiedMessage('exec'));
			return result;
		});
	}

	/** Kill a command's whole process group. A no-op when it already finished. */
	async kill(cmdId: string): Promise<void> {
		if (this.ctx.container?.running) await this.#exec('kill', killArgv(cmdId));
	}

	async readFile(path: string): Promise<Uint8Array> {
		return (await this.#fileOp('readFile', path, readFileArgv(path))).stdout;
	}

	async writeFile(path: string, content: Uint8Array): Promise<void> {
		await this.#fileOp('writeFile', path, writeFileArgv(path), new Blob([content]).stream());
	}

	async stat(path: string): Promise<RpcFileStat> {
		return parseStat(await this.#fileOp('stat', path, statArgv(path)));
	}

	async readdir(path: string): Promise<string[]> {
		return parseReaddir(await this.#fileOp('readdir', path, readdirArgv(path)));
	}

	async exists(path: string): Promise<boolean> {
		return this.#op(async () => {
			const result = await this.#exec('exists', existsArgv(path));
			if (result.exitCode > 1) throw fileError('exists', path, result);
			return result.exitCode === 0;
		});
	}

	async mkdir(path: string, recursive: boolean): Promise<void> {
		await this.#fileOp('mkdir', path, mkdirArgv(path, recursive));
	}

	async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
		await this.#fileOp('rm', path, rmArgv(path, recursive, force));
	}

	/**
	 * The workspace notice for one observer: `undefined` on first contact
	 * (which records the baseline) and while nothing changed, otherwise the
	 * notice for the latest change until the observer acknowledges it.
	 */
	async notice(scope: string): Promise<RpcNotice | undefined> {
		const state = this.#state;
		if (!state) return undefined;
		// Record a lost container now rather than at the next start, so the
		// model hears about the rollback before its next command.
		if (state.phase === 'started' && !this.ctx.container?.running) {
			await this.#recordLoss(state);
		}
		const key = `${SEEN_KEY_PREFIX}${scope}`;
		const seen = await this.ctx.storage.get<number>(key);
		const generation = state.generation;
		if (seen === undefined) {
			await this.ctx.storage.put(key, generation);
			return undefined;
		}
		if (seen >= generation || !state.lastChange) return undefined;
		return { generation, text: renderNotice(state.lastChange) };
	}

	/** Record that an observer was told about the workspace up to `generation`. */
	async acknowledgeNotice(scope: string, generation: number): Promise<void> {
		const key = `${SEEN_KEY_PREFIX}${scope}`;
		const seen = await this.ctx.storage.get<number>(key);
		if (seen === undefined || seen < generation) await this.ctx.storage.put(key, generation);
	}

	// ─── Supervision ─────────────────────────────────────────────────────

	async alarm(): Promise<void> {
		const state = this.#state;
		const container = this.ctx.container;
		if (!state || !container?.running) return;
		if (this.#busy()) {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
			return;
		}
		if (state.phase !== 'started') {
			// Left over from an unfinished stop (see LifecyclePhase).
			await container.destroy().catch(async () => {
				await this.ctx.storage.setAlarm(Date.now() + STOP_RETRY_MS);
			});
			return;
		}
		let running: number;
		try {
			running = parseSweep(await this.#exec('sweep', sweepArgv()));
		} catch {
			// The container is going away (the next call restarts it), or the
			// exec failed: check again later rather than drop supervision.
			if (container.running) await this.ctx.storage.setAlarm(Date.now() + STOP_RETRY_MS);
			return;
		}
		// Calls may have arrived while the sweep ran.
		if (running > 0 || this.#busy()) {
			// Work inside the container is not activity: keep the Durable Object
			// active (and the inactivity timer fresh) while commands run.
			await container.setInactivityTimeout(this.#inactivityMs());
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
			return;
		}
		const deadline = this.#lastActivity + this.#supervision().idleTimeoutMs;
		if (Date.now() < deadline) {
			await this.ctx.storage.setAlarm(deadline);
			return;
		}
		// No await between the checks above and #idleStop() claiming
		// #stopping, so no call can slip in between.
		await this.#idleStop();
	}

	// ─── Internals ───────────────────────────────────────────────────────

	get #container(): Container {
		const container = this.ctx.container;
		if (!container) {
			throw new Error(
				`[flue] ${FLUE_SANDBOX_CLASS_NAME} has no container. Add a "containers" entry with ` +
					`"class_name": "${FLUE_SANDBOX_CLASS_NAME}" and "scheduling_policy": "durable_object" to your wrangler config.`,
			);
		}
		return container;
	}

	#requireState(): SandboxState {
		if (!this.#state) {
			throw new Error(
				'[flue] This sandbox does not exist yet. An agent creates it when it first attaches ' +
					'with this sandbox id.',
			);
		}
		return this.#state;
	}

	/**
	 * The definition's settings for this sandbox. Throws when the definition
	 * is no longer exported or its settings are invalid; that fails the
	 * call that needed them, typically a start.
	 */
	#resolve(): ResolvedSettings {
		if (this.#settings) return this.#settings;
		const state = this.#requireState();
		const definition = definitions.get(state.definition);
		if (!definition) {
			throw new Error(
				`[flue] Sandbox "${state.id}" belongs to the cloudflareSandbox() definition "${state.definition}", ` +
					'which cloudflare.ts no longer exports. Export it again under that name to use this sandbox.',
			);
		}
		const input =
			typeof definition.settings === 'function'
				? definition.settings({ id: state.id, env: this.env as Cloudflare.Env })
				: definition.settings;
		const settings = validateSettings(input, state.definition);
		const resolved: ResolvedSettings = {
			image: this.#resolveImage(settings.image),
			// Not the platform's `lite`: its 1/16 vCPU makes each command
			// take most of a second.
			instance: settings.instance ?? 'standard-1',
			enableInternet: settings.enableInternet ?? true,
			persist: settings.persist ?? true,
			idleTimeoutMs: settings.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
		};
		this.#settings = resolved;
		return resolved;
	}

	/**
	 * What supervision needs, even when the settings no longer resolve: a
	 * running container must still stop when idle, and keeps its workspace.
	 */
	#supervision(): { idleTimeoutMs: number; persist: boolean } {
		try {
			return this.#resolve();
		} catch {
			return { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, persist: true };
		}
	}

	#inactivityMs(): number {
		return this.#supervision().idleTimeoutMs + BACKSTOP_MS;
	}

	#busy(): boolean {
		return this.#inflight > 0 || this.#starting !== undefined || this.#stopping !== undefined;
	}

	async #save(): Promise<void> {
		if (this.#state) await this.ctx.storage.put(STATE_KEY, this.#state);
	}

	/** One client call: counts as activity, waits out a stop, and starts the container. */
	async #op<T>(fn: () => Promise<T>): Promise<T> {
		this.#inflight++;
		try {
			if (this.#stopping) await this.#stopping.catch(() => {});
			this.#requireState();
			await this.#ensureRunning();
			return await fn();
		} finally {
			this.#inflight--;
			await this.#touch();
		}
	}

	/** A client file operation: one exec that must exit 0. */
	#fileOp(
		operation: string,
		path: string,
		argv: string[],
		stdin?: ReadableStream,
	): Promise<ExecResult> {
		return this.#op(() => this.#checked(operation, path, argv, stdin));
	}

	/**
	 * Record client activity. The Durable Object is evicted while its
	 * container idles, so the idle deadline must survive in storage.
	 */
	async #touch(): Promise<void> {
		this.#lastActivity = Date.now();
		await this.ctx.storage.put(ACTIVITY_KEY, this.#lastActivity);
	}

	/**
	 * Run an idle stop behind the `#stopping` barrier. `work` claims the
	 * barrier before its first await, so calls arriving during the stop
	 * wait for it and then start the container again.
	 */
	async #stop(work: () => Promise<void>): Promise<void> {
		const stopping = work();
		this.#stopping = stopping;
		try {
			await stopping;
		} finally {
			if (this.#stopping === stopping) this.#stopping = undefined;
		}
	}

	/** The image reference for a definition's `image`; `undefined` boots the default image. */
	#resolveImage(image: string | undefined): string | undefined {
		const images = this.#container.images;
		const keys = Object.keys(images);
		if (image === undefined) {
			if (keys.length > 1) {
				throw new Error(
					`[flue] cloudflareSandbox() needs an \`image\`: the ${FLUE_SANDBOX_CLASS_NAME} container configures several images (${keys.join(', ')}).`,
				);
			}
			return keys[0] === undefined ? undefined : images[keys[0]];
		}
		if (image in images) return images[image];
		if (/[/:@]/.test(image)) return image;
		throw new Error(
			`[flue] cloudflareSandbox() image "${image}" is not a key of the ${FLUE_SANDBOX_CLASS_NAME} container's images (${keys.join(', ') || 'none configured'}) or a full image reference.`,
		);
	}

	#ensureRunning(): Promise<void> {
		if (this.#starting) return this.#starting;
		if (this.#container.running && this.#requireState().phase === 'started') {
			return Promise.resolve();
		}
		this.#starting = this.#start().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #start(): Promise<void> {
		const state = this.#requireState();
		const container = this.#container;
		if (state.phase === 'started') await this.#recordLoss(state);
		// Left over from an unfinished stop (see LifecyclePhase).
		else if (container.running) await container.destroy();
		// Settings may be computed: resolve them for this start.
		this.#settings = undefined;
		const snapshot = state.snapshot;
		try {
			await this.#boot(snapshot);
		} catch (error) {
			if (!snapshot || !isSnapshotMissing(error)) throw error;
			// Expired or missing: start fresh from the image.
			state.snapshot = undefined;
			recordChange(state, { reason: 'reset', at: new Date().toISOString() });
			await this.#boot(undefined);
		}
		state.phase = 'started';
		await this.#save();
		await this.#touch();
		await this.ctx.storage.setAlarm(Date.now() + this.#resolve().idleTimeoutMs);
	}

	async #boot(snapshot: CloudflareSandboxSnapshot | undefined): Promise<void> {
		const state = this.#requireState();
		const settings = this.#resolve();
		const container = this.#container;
		container.start({
			...(snapshot
				? { containerSnapshot: { id: snapshot.id } }
				: { image: settings.image ?? DEFAULT_IMAGE }),
			enableInternet: settings.enableInternet,
			instance: settings.instance,
			// The default image has no long-lived main process of its own.
			...(settings.image === undefined ? { entrypoint: DEFAULT_ENTRYPOINT } : {}),
		});
		const exited = container.monitor().then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		try {
			await container.setInactivityTimeout(this.#inactivityMs());
			const prepared = await this.#exec('start', prepareArgv(state.cwds));
			if (prepared.exitCode !== 0) {
				throw new Error(`[flue] Sandbox container setup failed: ${prepared.stderr.trim()}`);
			}
		} catch (error) {
			// A container that stopped while starting reports why through
			// monitor(); the exec that noticed only says it is not running.
			const exit = await Promise.race([exited, sleep(2_000)]);
			if (container.running) await container.destroy().catch(() => {});
			throw exit ? stoppedWhileStarting(exit.error) : error;
		}
	}

	/**
	 * The container was lost without Flue stopping it (a crash, running out
	 * of memory, eviction, or the inactivity backstop): the next start rolls
	 * back to the last snapshot, or the image, and the workspace's users are
	 * told.
	 */
	async #recordLoss(state: SandboxState): Promise<void> {
		const at = new Date().toISOString();
		recordChange(
			state,
			state.snapshot
				? { reason: 'restored', at, snapshotCreatedAt: state.snapshot.createdAt }
				: { reason: 'reset', at },
		);
		state.phase = 'stopped';
		await this.#save();
	}

	async #takeSnapshot(): Promise<void> {
		const state = this.#requireState();
		const taken = await this.#container.snapshotContainer();
		state.snapshot = { id: taken.id, size: taken.size, createdAt: new Date().toISOString() };
		await this.#save();
	}

	async #idleStop(): Promise<void> {
		const state = this.#requireState();
		const container = this.#container;
		try {
			await this.#stop(async () => {
				if (this.#supervision().persist) {
					// Snapshots are point-in-time and don't pause the container,
					// so a request racing the stop can't tear the workspace.
					await this.#takeSnapshot();
				} else {
					state.snapshot = undefined;
					recordChange(state, { reason: 'reset', at: new Date().toISOString() });
				}
				state.phase = 'stopped';
				await this.#save();
				try {
					await container.destroy();
				} catch (error) {
					state.phase = 'started';
					await this.#save();
					throw error;
				}
			});
		} catch (error) {
			console.error('[flue] Sandbox idle stop failed; retrying.', error);
			await this.ctx.storage.setAlarm(Date.now() + STOP_RETRY_MS);
		}
	}

	/**
	 * One container exec with the baseline env. A failure while the
	 * container stopped becomes the RPC-safe sandbox-died error.
	 */
	async #exec(operation: string, argv: string[], stdin?: ReadableStream): Promise<ExecResult> {
		const container = this.#container;
		let output: ExecOutput;
		try {
			const process = await container.exec(argv, {
				env: { ...BASELINE_ENV },
				...(stdin ? { stdin } : {}),
			});
			output = await process.output();
		} catch (error) {
			this.#assertAlive(operation);
			throw error;
		}
		if (output.exitCode !== 0) this.#assertAlive(operation);
		return {
			exitCode: output.exitCode,
			stdout: new Uint8Array(output.stdout),
			stderr: decoder.decode(output.stderr),
		};
	}

	/** {@link #exec} for an operation on `path` that must exit 0. */
	async #checked(
		operation: string,
		path: string,
		argv: string[],
		stdin?: ReadableStream,
	): Promise<ExecResult> {
		const result = await this.#exec(operation, argv, stdin);
		if (result.exitCode !== 0) throw fileError(operation, path, result);
		return result;
	}

	/** Throw the sandbox-died error when the container stopped. */
	#assertAlive(operation: string): void {
		if (!this.ctx.container?.running) throw new Error(sandboxDiedMessage(operation));
	}
}

export interface CreateFlueSandboxClassOptions {
	/**
	 * The app's `cloudflare.ts` module, if any. Every `cloudflareSandbox()`
	 * definition it exports is registered under its export name.
	 */
	readonly module?: Record<string, unknown>;
}

/** Build the `FlueSandbox` Durable Object class and register the app's sandbox definitions. */
export function createFlueSandboxClass(
	options: CreateFlueSandboxClassOptions = {},
): ExtensionClass<any> {
	definitions.clear();
	for (const [name, value] of Object.entries(options.module ?? {})) {
		if (!isSandboxDefinition(value)) continue;
		if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === 'default') {
			throw new Error(
				`[flue] cloudflare.ts must export each cloudflareSandbox() definition under a named export; "${name}" is not one.`,
			);
		}
		const definition = value[DEFINITION];
		if (definition.name !== undefined && definition.name !== name) {
			throw new Error(
				`[flue] cloudflare.ts exports one cloudflareSandbox() definition as both "${definition.name}" and "${name}". ` +
					'The export name is the sandbox identity, so export each definition once.',
			);
		}
		definition.name = name;
		definitions.set(name, definition);
	}
	// Diagnostics and platform wrappers read `constructor.name`; bundlers may
	// rename the class binding.
	Object.defineProperty(FlueSandbox, 'name', {
		value: FLUE_SANDBOX_CLASS_NAME,
		configurable: true,
	});
	return FlueSandbox as ExtensionClass<any>;
}

const decoder = new TextDecoder();

/** The workspace was replaced underneath its users: bump the generation agents are notified of. */
function recordChange(state: SandboxState, change: CloudflareWorkspaceChange): void {
	state.generation++;
	state.lastChange = change;
}

function fileError(operation: string, path: string, result: ExecResult): Error {
	const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
	return new Error(`${operation} failed for ${path}: ${detail}`);
}

function newState(definition: string, id: string): SandboxState {
	return {
		definition,
		id,
		createdAt: new Date().toISOString(),
		cwds: [],
		phase: 'stopped',
		generation: 1,
	};
}

function isSnapshotMissing(error: unknown): error is Error {
	return error instanceof Error && /Snapshot ".*" was not found/.test(error.message);
}

function stoppedWhileStarting(error: unknown): Error {
	const reason = error instanceof Error ? error.message : 'its main process exited';
	return new Error(
		`[flue] The sandbox container stopped while starting: ${reason}. If the image's main process ` +
			'exits on its own, give it a long-lived one, such as CMD ["sleep", "infinity"].',
		{ cause: error },
	);
}

function sleep(ms: number): Promise<undefined> {
	return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

function renderNotice(change: CloudflareWorkspaceChange): string {
	const recheck =
		'Re-check the workspace before relying on files, installed packages, or command results from earlier in this conversation.';
	if (change.reason === 'restored') {
		return (
			`The sandbox container stopped unexpectedly, and its workspace was restored from a snapshot taken at ${change.snapshotCreatedAt}. ` +
			`Changes made after that time are gone, and no processes from before are running. ${recheck}`
		);
	}
	return `The sandbox workspace was reset to a fresh copy of its image: earlier files, installed packages, and processes are gone. ${recheck}`;
}
