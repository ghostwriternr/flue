/**
 * The RPC vocabulary of `FlueSandbox`, the Durable Object that owns the
 * container. Types and constants only, so a caller in another Durable
 * Object can use it without `cloudflare:workers` runtime imports.
 */

/** Class name of the Flue-owned Durable Object that runs Cloudflare sandboxes. */
export const FLUE_SANDBOX_CLASS_NAME = 'FlueSandbox';

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

/**
 * Errors lose their class across Durable Object RPC, so `FlueSandbox` tags a
 * sandbox death in the message for the caller to recognize.
 */
const SANDBOX_DIED_TAG = '[flue:sandbox_died:';

export function sandboxDiedMessage(operation: string): string {
	return `${SANDBOX_DIED_TAG}stopped] Sandbox ${operation} failed: the container stopped while the call was in flight.`;
}

/** The `FlueSandbox` RPC surface. */
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
}
