---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://github.com/cloudflare/computer",
  "aliases": ["@cloudflare/computer", "@cloudflare/shell", "@cloudflare/workspace"]
}
---

# Add a Flue Sandbox Adapter: Cloudflare Computer

You are an AI coding agent installing the Cloudflare Computer sandbox adapter
for a Flue Cloudflare-target project. Follow these instructions exactly.
Confirm with the user only when something is genuinely ambiguous.

## What this adapter does

Wraps a `@cloudflare/computer` `Workspace` — a durable, SQLite-backed virtual
filesystem that lives in the agent's own Durable Object — into Flue's
`SandboxFactory` interface. Commands run through the package's worker-shell
backend: a just-bash shell in a Dynamic Worker operating directly on the
durable files. Because `exec()` works, agents get Flue's full standard tool
set (`bash`, `grep`, `glob`, `read`, `write`, `edit`) with no substitutions,
plus a typed git client (`workspace.git`) for application-owned hydration.

`@cloudflare/computer` is an early preview from Cloudflare — suitable for
experiments and prototypes, not production. Tell the user this once during
installation.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/cloudflare-computer.ts`.

If neither feels right, ask the user before writing. Create any missing parent
directories.

## File contents

Write this file verbatim. It requires a Cloudflare Worker target with a
`worker_loaders` binding.

```ts
// flue-blueprint: sandbox/cloudflare-computer@1
import {
	type DurableObjectStorageLike,
	Workspace,
	type WorkspaceOptions,
	type WorkspaceRuntimeExecHandle,
} from '@cloudflare/computer';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { createGitClient } from '@cloudflare/computer/git';
import type { FileStat, Sandbox, SandboxFactory, ShellResult } from '@flue/runtime';
import { extend, getDurableObjectIdentity } from '@flue/runtime/cloudflare';

// One live Durable Object instance exists per id, and the agent renders
// inside it, so per-isolate module state keyed by the DO id string connects
// the extension-captured host to the sandbox factory. The Workspace rides on
// the host entry: it is bound to its instance's storage cache, and a new
// construction of the same Durable Object (eviction, dev reload) must not
// see the previous incarnation's Workspace.
interface WorkspaceHostHandle {
	readonly ctx: DurableObjectState;
	readonly env: Record<string, unknown>;
	workspace?: Workspace;
}
const hosts = new Map<string, WorkspaceHostHandle>();

/**
 * Cloudflare extension that turns the agent's Durable Object into a
 * workspace host. It captures the Durable Object state the shell backend
 * needs (`ctx.exports` mints the loopback binding the shell dials back
 * through) and exposes the `__getWorkspaceStub()` RPC method that
 * `@cloudflare/computer`'s `getWorkspace(stub)` — and the shell's
 * `env.HOST` — resolve against.
 *
 * Re-export it from every agent module that uses this sandbox:
 *
 *   export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';
 */
export const workspaceHost = extend({
	base: (Base) =>
		class extends Base {
			readonly #workspaceHostKey: string;

			constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
				super(ctx, env);
				this.#workspaceHostKey = ctx.id.toString();
				hosts.set(this.#workspaceHostKey, { ctx, env });
			}

			async __getWorkspaceStub() {
				const workspace = hosts.get(this.#workspaceHostKey)?.workspace;
				if (!workspace) {
					throw new Error(
						'[flue] This agent has no live Workspace yet. It is created when the ' +
							'agent initializes its sandbox; retry after the first submission.',
					);
				}
				await workspace.ready();
				return workspace.stub();
			}
		},
});

export interface GetComputerWorkspaceOptions {
	/** The Worker Loader binding (`env.LOADER`) the shell backend runs commands through. */
	loader: WorkerLoader;
	/**
	 * Reshape the generated `WorkspaceOptions` before construction: add R2
	 * mounts, an observer, a `defaultGitIdentity`, additional backends, etc.
	 */
	workspace?: (defaults: WorkspaceOptions) => WorkspaceOptions;
}

/**
 * The Workspace for the current agent instance — one durable filesystem per
 * Durable Object, created on first call and shared with the sandbox. Call it
 * from agent code that hydrates or inspects the filesystem out-of-band
 * (`workspace.git.clone(...)`, `workspace.fs.writeFile(...)`).
 */
export function getComputerWorkspace(options: GetComputerWorkspaceOptions): Workspace {
	if (!options?.loader) {
		throw new Error(
			'[flue] getComputerWorkspace requires a WorkerLoader binding. Add this to your wrangler.jsonc:\n' +
				'  { "worker_loaders": [{ "binding": "LOADER" }] }\n' +
				'add "experimental" to compatibility_flags, and pass `loader: env.LOADER`. Worker Loader is ' +
				'currently in beta — see https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/.',
		);
	}
	const identity = getDurableObjectIdentity();
	const host = hosts.get(identity.id);
	if (!host) {
		throw new Error(
			'[flue] The agent Durable Object is not a workspace host. Add\n' +
				"  export { workspaceHost as cloudflare } from '<path-to>/sandboxes/cloudflare-computer';\n" +
				'to the agent module so the shell backend can dial back into the workspace.',
		);
	}
	if (host.workspace) return host.workspace;

	const defaults: WorkspaceOptions = {
		// ctx.storage.sql.exec returns a narrower row type than
		// DurableObjectStorageLike declares; the runtime shape matches.
		storage: host.ctx.storage as unknown as DurableObjectStorageLike,
		sessionId: identity.id,
		// Detached workspace work (module executions, deferred sync) must
		// outlive the request that started it.
		waitUntil: host.ctx.waitUntil.bind(host.ctx),
		// Enables `workspace.git` and the shell's built-in `git` command.
		// Delete this line (plus the import and the @platformatic/vfs
		// dependency) to keep git out of the build when the agent never
		// touches it.
		git: createGitClient(),
		backends: [
			// just-bash handles every exec by default. That is this adapter's
			// wiring, not the package's ceiling: a Workspace can register more
			// backends against the same durable files — notably the full-Linux
			// CloudflareContainerBackend from
			// @cloudflare/computer/backends/container — appended here via the
			// `workspace` hook and selected per call with
			// `runtime.exec(cmd, { backend: '<id>' })`.
			new WorkerShellBackend({
				loader: options.loader,
				workspace: { binding: identity.bindingName, id: identity.id },
				ctx: host.ctx,
			}),
		],
	};
	host.workspace = new Workspace(options.workspace ? options.workspace(defaults) : defaults);
	return host.workspace;
}

/**
 * The environment a cloudflare-computer agent runs in: the generic `Sandbox`
 * verbs route through the workspace, and the workspace itself rides along as
 * the sandbox's native surface. Narrow to it with {@link computerWorkspace}.
 */
export interface ComputerSandboxEnv extends Sandbox {
	readonly workspace: Workspace;
}

/**
 * Narrow an agent's `harness.sandbox` to this sandbox's native surface — the
 * `@cloudflare/computer` {@link Workspace} — with a runtime check. Throws
 * when the agent runs on a different sandbox.
 */
export function computerWorkspace(sandbox: Sandbox): Workspace {
	const workspace = (sandbox as Partial<ComputerSandboxEnv>).workspace;
	if (!(workspace instanceof Workspace)) {
		throw new Error(
			'[flue] computerWorkspace(harness.sandbox) requires the cloudflare-computer sandbox — ' +
				'this agent runs on a different environment.',
		);
	}
	return workspace;
}

// The worker-shell backend's own default working directory.
const DEFAULT_CWD = '/workspace';

export function getComputerSandbox(options: GetComputerWorkspaceOptions): SandboxFactory {
	return {
		async createSandbox(): Promise<ComputerSandboxEnv> {
			const workspace = getComputerWorkspace(options);
			await workspace.fs.mkdir(DEFAULT_CWD, { recursive: true });
			return { ...createWorkspaceSandbox(workspace, DEFAULT_CWD), workspace };
		},
		// No `tools` override: exec() works here, so the framework's standard
		// set (bash/grep/glob/read/write/edit) applies as-is.
	};
}

function normalizePath(p: string): string {
	const parts = p.split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') result.pop();
		else result.push(part);
	}
	return `/${result.join('/')}`;
}

function abortError(): Error {
	return new DOMException('The operation was aborted.', 'AbortError');
}

async function settleExec(
	run: WorkspaceRuntimeExecHandle<'utf8'>,
	signal?: AbortSignal,
): Promise<ShellResult> {
	try {
		const result = signal
			? await new Promise<Awaited<ReturnType<typeof run.result>>>((resolve, reject) => {
					// Reject promptly on abort — never gated on the remote command's
					// settlement — and kill the run best-effort behind it.
					const onAbort = () => {
						void run.kill('SIGKILL').catch(() => {});
						reject(abortError());
					};
					signal.addEventListener('abort', onAbort, { once: true });
					run.result().then(
						(value) => {
							signal.removeEventListener('abort', onAbort);
							resolve(value);
						},
						(error) => {
							signal.removeEventListener('abort', onAbort);
							reject(error);
						},
					);
				})
			: await run.result();
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
	} finally {
		run[Symbol.dispose]();
	}
}

function createWorkspaceSandbox(workspace: Workspace, cwd: string): Sandbox {
	const normalizedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (normalizedCwd === '/') return normalizePath(`/${p}`);
		return normalizePath(`${normalizedCwd}/${p}`);
	};
	const fs = workspace.fs;
	const errorCode = (error: unknown): string | undefined =>
		(error as { code?: string } | undefined)?.code;

	return {
		async exec(command, options): Promise<ShellResult> {
			if (options?.signal?.aborted) throw abortError();
			const run = await workspace.runtime.exec(command, {
				cwd: options?.cwd !== undefined ? resolvePath(options.cwd) : normalizedCwd,
				env: options?.env,
				timeoutMs: options?.timeoutMs,
				encoding: 'utf8',
			});
			return settleExec(run, options?.signal);
		},
		async readFile(path: string): Promise<string> {
			return fs.readFile(resolvePath(path), 'utf8');
		},
		async readFileBuffer(path: string): Promise<Uint8Array> {
			const stream = await fs.readFile(resolvePath(path));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		},
		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			try {
				await fs.writeFile(resolved, content);
			} catch (error) {
				// ENOENT here means a missing parent directory; create it and
				// retry once.
				if (errorCode(error) !== 'ENOENT') throw error;
				const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
				await fs.mkdir(parent, { recursive: true });
				await fs.writeFile(resolved, content);
			}
		},
		async stat(path: string): Promise<FileStat> {
			const s = await fs.stat(resolvePath(path));
			// fs.stat follows symlinks and reports no symlink flag; leave
			// isSymbolicLink unset rather than fabricate one.
			return {
				isFile: s.isFile,
				isDirectory: s.isDirectory,
				size: s.size,
				mtime: new Date(s.mtime),
			};
		},
		async readdir(path: string): Promise<string[]> {
			return (await fs.readdir(resolvePath(path))).map((entry) => entry.name);
		},
		async exists(path: string): Promise<boolean> {
			try {
				await fs.stat(resolvePath(path));
				return true;
			} catch (error) {
				const code = errorCode(error);
				if (code === 'ENOENT' || code === 'ENOTDIR') return false;
				throw error;
			}
		},
		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await fs.mkdir(resolvePath(path), opts?.recursive ? { recursive: true } : undefined);
		},
		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			const mapped: { recursive?: true; force?: true } = {};
			if (opts?.recursive) mapped.recursive = true;
			if (opts?.force) mapped.force = true;
			await fs.rm(resolvePath(path), mapped);
		},
		cwd: normalizedCwd,
		resolvePath,
	};
}
```

## Required wiring beyond the adapter file

Two short additions make the shell backend's dial-back loop work. Both are
required; skipping either surfaces only at the first `bash` tool call.

1. **Worker entry re-export.** The shell's Dynamic Worker reaches the
   workspace through a loopback binding that Cloudflare mints only for
   classes exported from the Worker's entry module. Flue re-exports
   everything from the project's `cloudflare.ts` (same directory as
   `app.ts`; create it if absent) — add:

   ```ts
   export { WorkspaceServiceProxy } from '@cloudflare/computer';
   ```

   If the project has no `cloudflare.ts`, create it containing only that
   line. Do not add a default export unless one already exists.

2. **Agent module extension.** Each agent module that uses this sandbox
   must host the workspace on its Durable Object:

   ```ts
   export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';
   ```

   If the module already exports its own `cloudflare` extension, compose the
   behavior instead of re-exporting: replicate the `base` class from
   `workspaceHost` inside the existing extension's `base`.

## Required dependencies

If the user's `package.json` does not already list them, add them with the
user's package manager:

```bash
npm install @cloudflare/computer@^0.1.1 @platformatic/vfs@^0.4.0
```

`@platformatic/vfs` is the filesystem adapter `workspace.git` loads lazily;
omit it only when you also delete the adapter's `createGitClient()` line.
The other optional peer dependencies (`ai`, `zod`) are not used by this
adapter; do not install them.

## Authentication

No provider API key is required. The project must run on Cloudflare Workers
and must configure a Worker Loader binding plus the `experimental`
compatibility flag. Ensure `wrangler.jsonc` contains:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

Worker Loader is currently beta-gated. Never invent Cloudflare account details
or tokens; the user authenticates through their existing Wrangler setup.

## Behavior and tradeoffs

The adapter provides a real `exec()`, so Flue's standard tool set applies
unchanged — no `tools` override. Commands run in just-bash, a POSIX-style
shell implemented in JavaScript inside a Dynamic Worker: coreutils, pipes,
redirects, `grep`, and `find` work; native binaries, `npm`, and arbitrary
network access do not. Filesystem state is durable across Durable Object
restarts and capped around 10 GB (it shares the DO's SQLite storage).
Application code uses the file verbs on `harness.sandbox`, or narrows to the
native surface with `computerWorkspace(harness.sandbox)` for workspace
operations the generic interface doesn't cover (git, mounts, streams).

If the user needs language toolchains or native binaries, use the
Cloudflare sandbox on Containers instead (`flue add sandbox cloudflare`). `@cloudflare/computer` also
ships a container backend (`CloudflareContainerBackend`) that syncs the same
durable filesystem into a Cloudflare Container; treat that as an advanced,
application-owned configuration via the `workspace` reshape hook, not part
of this adapter.

Application-specific data loading (git clones, R2 hydration) belongs outside
this adapter: call `getComputerWorkspace(...)` and use `workspace.git` /
`workspace.fs`, or attach read-only R2 mounts through the `workspace` hook.

## Wiring it into an agent

```ts
'use agent';
import { env } from 'cloudflare:workers';
import { useModel, useSandbox } from '@flue/runtime';
import { getComputerSandbox } from '../sandboxes/cloudflare-computer';

export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';

interface Env {
	LOADER: WorkerLoader;
}

const { LOADER } = env as unknown as Env;

export function Assistant() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	useSandbox(getComputerSandbox({ loader: LOADER }));
	return 'You explore and edit your durable workspace with the standard file and shell tools.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount the agent's HTTP surface explicitly in `app.ts`
(`app.route('/agents/<name>', createAgentRouter(Assistant))`, with
`createAgentRouter` from `@flue/runtime/routing`) if it needs an endpoint —
`dispatch()` needs no mount.

## Migrating from Cloudflare Shell

When the project contains a `sandboxes/cloudflare-shell.ts` adapter (the
predecessor blueprint for `@cloudflare/shell`), migrate it:

1. Write `sandboxes/cloudflare-computer.ts` as above and delete
   `sandboxes/cloudflare-shell.ts`.
2. In agent modules, replace `getShellSandbox({ workspace: getDefaultWorkspace(), loader })`
   with `getComputerSandbox({ loader })`, replace `shellWorkspace(...)` with
   `computerWorkspace(...)`, and add the `workspaceHost` re-export. Rewrite
   application-owned hydration onto `getComputerWorkspace(...)` —
   `@cloudflare/shell`'s `createGit(new WorkspaceFileSystem(ws))` becomes the
   built-in `workspace.git`, and R2 bucket copies can become read-only mounts
   via the `workspace` reshape hook.
3. Remove the `@cloudflare/shell` and `@cloudflare/codemode` dependencies.
4. Add the `experimental` compatibility flag and the two wiring re-exports
   (the old adapter needed neither).
5. Tell the user: prompts that leaned on the old `code` tool now use the
   standard `bash`/`grep`/`glob` tools, and files stored by
   `@cloudflare/shell` do not carry over — `@cloudflare/computer` keeps its
   filesystem in its own SQLite tables and does not read the old package's.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Verify

1. Run the user's typechecker.
2. Confirm the import path matches where you wrote `cloudflare-computer.ts`.
3. Confirm `wrangler.jsonc` has a `worker_loaders` binding matching the code and `"experimental"` in `compatibility_flags`.
4. Confirm `cloudflare.ts` re-exports `WorkspaceServiceProxy` and each sandbox-using agent module re-exports `workspaceHost as cloudflare`.
5. Tell the user to use `vite dev` (the Cloudflare target comes from the `cloudflare()` plugin in `vite.config.ts`); if local Wrangler cannot simulate Worker Loader, use remote dev or deploy a preview Worker with `vite build && wrangler deploy`.

## Upgrade Guide

### Version 1 — 2026-08-04

Initial version.
