---
{
  "kind": "sandbox",
  "version": 2,
  "website": "https://developers.cloudflare.com/containers",
  "aliases": ["@cloudflare/sandbox"]
}
---

# Add a Flue Blueprint: Cloudflare Sandbox

You are an AI coding agent helping a user wire up a Cloudflare sandbox in
their Flue project. **This is not a normal adapter.** Read this whole
file before you write or install anything — the right action is very
different depending on what target the project is already on.

## The single most important thing to tell the user

The Cloudflare sandbox runs on Cloudflare Containers, attached to a Durable
Object that Flue ships: `FlueSandbox`. **It only works inside a Worker** —
it cannot be invoked from a Node.js process.
Because of that, Flue treats the Cloudflare sandbox as a first-class
**build target**, not a drop-in adapter file.

If the user is already on the Cloudflare target: there is no project-owned
adapter file to install and no extra package. Add the `FlueSandbox`
container entry and its migration to `wrangler.jsonc`, add a `Dockerfile`,
export a `cloudflareSandbox()` definition from `cloudflare.ts`, and pass
it to `useSandbox()` in the agent. Skip to
["Path A"](#path-a-already-on-the-cloudflare-target) below.

If the project already wraps `getSandbox(...)` from `@cloudflare/sandbox`
0.x with `cloudflareSandbox(...)`, it is on the deprecated path: follow the
[Version 2 upgrade guide](#version-2--2026-10-13) instead.

If the user is on the Node target (or hasn't picked yet): adding a
Cloudflare sandbox means **migrating the entire project to deploy on
Cloudflare Workers**. This is a real, multi-step change — Workers, Durable
Objects, `wrangler`, container builds, the lot. Don't pretend it's a
single-file add. Skip to ["Path B"](#path-b-currently-on-the-node-target)
and **confirm with the user before proceeding**.

For other sandbox providers that are reachable from a Node-target Flue
project (Daytona, E2B, Modal, Vercel, etc.), see `flue add` for those
adapters instead. They install in one file and don't require a deploy
target change.

## Figure out which path you're on

Before writing anything, look at the user's project to determine the
current target:

1. Check `vite.config.ts` for the `cloudflare()` plugin (from
   `@cloudflare/vite-plugin`) alongside `flue()`, and `flue.config.ts` for
   `target: 'cloudflare'`. Either is a strong signal they're on Cloudflare
   already. (Scripts don't distinguish targets — dev and build are
   `vite dev` / `vite build` on both.)
2. Check for `wrangler.jsonc` / `wrangler.toml` / `wrangler.json` at the
   project root. Cloudflare-targeted Flue projects always have one.
3. Check `package.json` for `wrangler`, `agents`, and
   `@cloudflare/vite-plugin`.

If you find clear evidence of the Cloudflare target: **Path A**.

If you find no Cloudflare wiring (no `wrangler.jsonc`, no `wrangler` dep,
no `cloudflare()` plugin in `vite.config.ts`): **Path B** — and
**confirm with the user that they want to migrate** before doing anything.

If you can't tell or it's ambiguous: ask the user directly. Don't guess.

---

## Path A: Already on the Cloudflare target

You don't need an adapter file or a sandbox package: `@flue/runtime/cloudflare`
exports `cloudflareSandbox()`, and the generated Worker exports the
`FlueSandbox` Durable Object once `wrangler.jsonc` has its container
entry. The canonical guide is:

> https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/

The short version, for your reference:

1. Make sure the Cloudflare tooling is new enough: `@cloudflare/vite-plugin`
   1.63 or later, `wrangler` 4.150 or later, and (if the project uses them)
   `@cloudflare/workers-types` 5.20261013 or later. Upgrade with the user's
   package manager.

2. Add the `FlueSandbox` container entry and a migration to the user's
   `wrangler.jsonc` at the project root:

   ```jsonc
   {
     "containers": [
       {
         "class_name": "FlueSandbox",
         "name": "<worker-name>-sandbox",
         "scheduling_policy": "durable_object",
         "images": { "default": { "dockerfile": "./Dockerfile" } }
       }
     ],
     "migrations": [
       // ...the user's existing entries, unchanged...
       { "tag": "flue-sandbox", "new_sqlite_classes": ["FlueSandbox"] }
     ]
   }
   ```

   Preserve the user's existing top-level migration history and append a new
   uniquely tagged entry. Do not replace deployed migration entries — in
   particular the per-agent `flue-class-Flue<PascalName>Agent` entries for
   the generated agent Durable Object classes. Do not add a Durable Object
   binding for `FlueSandbox`: `flueWorkerConfig()` adds the
   `FLUE_SANDBOX` binding when it sees the container entry, and rejects
   an entry that sets `image`, `instance_type`, or `max_instances`, or lacks
   `"scheduling_policy": "durable_object"`.

3. Add a `Dockerfile` at the project root. Flue runs every command and file
   operation through `bash`, coreutils, findutils, and util-linux
   (`setsid`), and needs a long-lived main process. Start from this
   template and add the tools the agent needs:

   ```dockerfile
   FROM node:24-trixie-slim
   RUN apt-get update && apt-get install -y --no-install-recommends \
         bash ca-certificates git ripgrep tini procps \
       && rm -rf /var/lib/apt/lists/*
   ENTRYPOINT ["/usr/bin/tini", "--"]
   CMD ["sleep", "infinity"]
   ```

   Image `ENV` lines do not reach agent commands. Pass environment
   variables when attaching (`workspace.attach({ env })`) instead, and
   never put secrets there (see step 5).

4. Define the sandbox in `cloudflare.ts` (create the file next to `app.ts`
   if the project has none), and use it in an agent:

   ```ts
   // src/cloudflare.ts
   import { cloudflareSandbox } from '@flue/runtime/cloudflare';

   export const workspace = cloudflareSandbox();
   ```

   ```ts
   // src/agents/assistant.ts
   'use agent';
   import { useModel, useSandbox } from '@flue/runtime';
   import { workspace } from '../cloudflare.ts';

   export function Assistant() {
     useModel('anthropic/claude-opus-4-7');
     useSandbox(workspace);
     return 'You are a helpful assistant with a full sandbox.';
   }
   ```

   The export name and a sandbox id identify each sandbox, so pick a
   stable name; renaming it later starts new sandboxes. The sandbox id
   defaults to the agent instance id, so each agent instance gets its own
   container and workspace. Use `workspace.attach({ id, cwd, env })` to
   share one sandbox between agents, pick another working directory, or
   set command environment. The workspace persists across idle stops (Flue
   snapshots it after 10 idle minutes by default); set `persist: false`
   for a workspace that is discarded at each stop. `instance` defaults to
   `'standard-1'`; do not suggest `'lite'` for coding agents. With
   several `images`, each definition must name one with `image`. Settings
   are read from code on every container start, so changing them later
   and redeploying reaches existing sandboxes.

5. Credentials stay outside the container. To give commands access to an
   authenticated API, export a `WorkerEntrypoint` from `cloudflare.ts` that
   adds the credential, and route the API's hostname to it from a settings
   function, which receives the Worker's `exports`:

   ```ts
   export const workspace = cloudflareSandbox(({ id, exports }) => {
     const api = exports.ExampleApiProxy({ props: { sandboxId: id } });
     return {
       intercepts: [{ host: 'api.example.com', https: true, target: api }],
     };
   });
   ```

6. Tell the user to put local variables in `.dev.vars` or `.env` and run
   `vite dev` for local development (Docker must be running; it builds the
   image locally), then `vite build && wrangler deploy --secrets-file .env`
   to deploy. Containers are a Workers Paid feature.

If the user wants several images (for example one for Python, one for
Node), add them to the same container entry's `images` map and export one
definition per image, each with `cloudflareSandbox({ image: '<key>' })`.

---

## Path B: Currently on the Node target

**Stop. Confirm with the user first.**

Adding a Cloudflare sandbox to a project that currently runs on Node is
**not** a one-file change. The sandbox itself is a Cloudflare Containers
Durable Object, which only exists inside a Cloudflare Worker. To use it,
the entire Flue project has to change its deploy target from Node to
Cloudflare Workers, which is a substantial migration that includes:

- Adding `cloudflare({ config: flueWorkerConfig() })` (the plugin from
  `@cloudflare/vite-plugin`, the customizer from `@flue/vite`) to
  `vite.config.ts` after `flue()` — that plugin's presence is what selects
  the Cloudflare target; dev and build stay `vite dev` / `vite build`.
- Adding `wrangler`, `@cloudflare/vite-plugin`, and `agents` (Cloudflare's
  Agents SDK) as dependencies.
- Adding a `wrangler.jsonc` with the `FlueSandbox` container entry,
  user-authored migration entries for each agent's generated
  `Flue<PascalName>Agent` class, and an R2 binding if they want persistent
  file storage.
- Adding a `Dockerfile` for the container image.
- Setting up Wrangler authentication (`wrangler login`) and a Cloudflare
  account that has Containers enabled (currently a Workers Paid feature).
- Reviewing any Node-only code in the user's existing agents and
  adapters. Anything that imports from `node:fs`, opens TCP sockets via
  `net`, uses `child_process`, or depends on long-lived background work
  needs rethinking on the Workers runtime.

Before doing any of this, **ask the user**:

1. Are you OK migrating this whole project to deploy on Cloudflare
   Workers? (yes/no)
2. Do you have a Cloudflare account with Containers access? (Containers
   is currently a Workers Paid feature.)

If they say no to either, **stop and recommend an alternative**. Other
sandbox adapters that work from a Node-target Flue project include:

- **Daytona** (`flue add sandbox daytona`) — provider-managed sandboxes via
  `@daytona/sdk`.
- **E2B** (`flue add sandbox e2b`) — Firecracker microVMs via the `e2b` package.
- **Modal** (`flue add sandbox modal`) — sandboxes on Modal's serverless platform.
- **Vercel Sandbox** (`flue add sandbox vercel`) — `@vercel/sandbox`.
- **boxd** (`flue add sandbox boxd`) — microVMs via `@boxd-sh/sdk`.
- **exe.dev** (`flue add sandbox exedev`) — SSH-accessed VMs.

These all keep the project on the Node target and don't require a
platform migration.

If the user does say yes to migrating, **do not try to do the whole
migration in one shot**. Direct them at the canonical guide instead:

> https://flueframework.com/docs/ecosystem/deploy/cloudflare/

That document walks through the migration end-to-end:

- Hello-world agent on Cloudflare (`vite dev` with the `cloudflare()`
  plugin in `vite.config.ts`).
- Adding `wrangler.jsonc`, `.env`, and the `cloudflare()` plugin to
  `vite.config.ts`.
- Using Flue's default virtual sandbox if the user only needs an in-memory filesystem with built-in shell and file-search tools.
- Adding the Cloudflare sandbox container at the end (which is the same
  blueprint as Path A above).

Read the guide, then walk the user through it section by section. Don't
short-circuit straight to writing a `wrangler.jsonc` and `Dockerfile`
without first confirming the basics work on the Cloudflare target.

---

## Hard rules

- **Do not** create a `sandboxes/cloudflare.ts` file under any source
  directory. Import `cloudflareSandbox` from `@flue/runtime/cloudflare`; no
  project-owned adapter file is needed.
- **Do not** silently migrate a Node-target project to Cloudflare. Always
  confirm first.
- **Do not** invent a Cloudflare account, API token, or `account_id`. The
  user authenticates with `wrangler login` (or `CLOUDFLARE_API_TOKEN` in
  CI); never guess values.
- **Do not** install `@cloudflare/sandbox` for this integration, or export a
  `Sandbox` class from `cloudflare.ts`. Apps may still install it for its
  own helpers (`DirectoryBackup`, `S3Mount`, `Files`).
- **Do not** put secrets in `attach({ env })` or the Dockerfile. Use
  `intercepts`.
- **Do not** define a `cloudflareSandbox()` inside an agent module or
  leave it unexported: agents can only use definitions that `cloudflare.ts`
  exports.
- **Do not** add a `FlueSandbox` Durable Object binding by hand;
  `flueWorkerConfig()` adds it. Don't import from `@flue/runtime/internal`.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change, and preserve customizations. This blueprint has no primary marked file, so comparison is the durable update path; do not add a marker to an auxiliary or deployment file.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-10-13

Move from the `@cloudflare/sandbox` 0.x `Sandbox` Durable Object, which
Sandbox SDK 1.0 removed, to `FlueSandbox`. `cloudflareSandbox(getSandbox(...))`
keeps working through Flue 2.x with a deprecation warning and is removed in
3.0, so upgrading Flue does not force this migration. The migration deploy
is one-way: running 0.x containers and their files are lost. If the user
needs files from a running sandbox, back them up first (for example with
0.x `createBackup`).

The core change is a sandbox definition in `cloudflare.ts` that replaces
the 0.x class, and an agent that uses it:

```diff
--- a/src/cloudflare.ts
+++ b/src/cloudflare.ts
-export { Sandbox } from '@cloudflare/sandbox';
+import { cloudflareSandbox } from '@flue/runtime/cloudflare';
+
+export const workspace = cloudflareSandbox();
--- a/src/agents/assistant.ts
+++ b/src/agents/assistant.ts
-import { env } from 'cloudflare:workers';
-import { getSandbox } from '@cloudflare/sandbox';
-import { cloudflareSandbox } from '@flue/runtime/cloudflare';
+import { workspace } from '../cloudflare.ts';
@@
-  useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)));
+  useSandbox(workspace);
```

1. **Agent.** Replace the stub with the definition, as above. Keep
   `useSandbox(workspace)` when the sandbox id was the agent instance id
   (the default); otherwise use `workspace.attach({ id })`. A `cwd` passed
   to the old wrapper moves to `attach({ cwd })`.

2. **Direct stub calls.** Code that called the 0.x stub itself, outside
   `cloudflareSandbox()`, moves to the handle from
   `getCloudflareSandbox(harness.sandbox)` in an agent or
   `workspace.get(env, id)` elsewhere: `getState()` becomes `status()`,
   `destroy()` becomes `reset()`, and requests to a port in the container
   (`containerFetch()`, or preview URLs routed with `proxyToSandbox()`)
   become `fetch(port, request)`, which the app routes itself. File and
   command calls go through `harness.sandbox`.

3. **`cloudflare.ts`.** Replace `export { Sandbox } from '@cloudflare/sandbox'`
   with the definition. Map `getSandbox()` options to settings:
   `sleepAfter` becomes `idleTimeoutMs`; `keepAlive: true` becomes a longer
   `idleTimeoutMs`; drop `normalizeId`, `transport`, `enableDefaultSession`,
   and `containerTimeouts`. Uninstall `@cloudflare/sandbox` unless the app
   imports `Files`, `S3Mount`, or `DirectoryBackup` itself.

4. **`wrangler.jsonc`.**
   - Remove the `Sandbox` Durable Object binding and the old `containers`
     entry.
   - Add the `FlueSandbox` container entry from Path A step 2 with a
     **new** `name`.
   - Append one migration that retires the old class and adds `FlueSandbox`:

     ```jsonc
     { "tag": "flue-sandbox", "deleted_classes": ["Sandbox"], "new_sqlite_classes": ["FlueSandbox"] }
     ```

     Use the app's own class names if it exported the 0.x class under
     another name.

5. **Dockerfile.** Replace `FROM docker.io/cloudflare/sandbox:<version>`
   with the Path A step 3 template and keep the user's own `RUN` lines.
   Move `ENV` lines into `attach({ env })`.

6. **Network.** A 0.x subclass with `enableInternet = false` becomes
   `cloudflareSandbox({ enableInternet: false })`. Outbound handlers become
   exported `WorkerEntrypoint` classes, routed with `intercepts` whose
   `target` comes from a settings function's `exports`, and
   `onStart` hooks become the definition's `onStart`.

7. **Several 0.x sandbox classes** (for example `PyBox` and `NodeBox`)
   become entries in the `FlueSandbox` container entry's `images` map, and
   one exported definition each, with `cloudflareSandbox({ image })`.
   Delete each old class in the migration.

8. **Tooling.** Upgrade `@cloudflare/vite-plugin` to 1.63 or later and
   `wrangler` to 4.150 or later.

9. **Deploy once at 100%.** Wrangler rejects gradual deployments across this
   migration.

10. **Delete the old container application.** It keeps running and billing
   otherwise, and deleting a Worker does not remove it: find it with
   `wrangler containers list`, then run `wrangler containers delete <id>`.
