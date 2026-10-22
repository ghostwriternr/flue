/**
 * The programs `FlueSandbox` runs inside its container, and how it reads
 * their output. Everything it does in the container is a plain
 * `container.exec(argv)`: file operations are coreutils, and each command
 * runs as a record under `/var/lib/flue/exec/<id>/` (pid, output, exit code,
 * boot id) in its own process group, so it can be killed as a whole and
 * outlives either Durable Object restarting.
 *
 * Pure argv builders and parsers: no `cloudflare:workers` or Durable Object
 * state, so the lifecycle in `flue-sandbox-class.ts` reads as lifecycle only.
 */
import type { RpcFileStat, RpcRunOptions, RpcShellResult } from './flue-sandbox-protocol.ts';

/** Output of one `container.exec`. */
export interface ExecResult {
	exitCode: number;
	stdout: Uint8Array;
	stderr: string;
}

/** Environment every command starts from (`env -i`), so local and deployed runs match. */
export const BASELINE_ENV: Readonly<Record<string, string>> = {
	HOME: '/root',
	LANG: 'C.UTF-8',
	TERM: 'dumb',
	PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

/** Exit code of the run wrapper when the record id is already taken. */
export const RECORD_ID_IN_USE_EXIT = 97;

const EXEC_ROOT = '/var/lib/flue/exec';
/** Each stream of a command result keeps at most this many trailing bytes. */
const OUTPUT_TAIL_BYTES = 1024 * 1024;
/** Largest file `readFile` returns (Durable Object RPC messages cap at 32 MiB). */
const FILE_READ_LIMIT_BYTES = 32 * 1024 * 1024 - 64 * 1024;
/** Running records older than this with no caller are killed (seconds). */
const ORPHAN_CEILING_S = 2 * 60 * 60;
/** Finished records nobody collected are removed after this long (seconds). */
const UNCOLLECTED_TTL_S = 15 * 60;

/**
 * Runs one command as a record and prints its result. Arguments: record
 * dir, output cap, cwd, then argv. The command gets its own session and
 * process group (`setsid`), writes its pid, output, and exit code to files,
 * and survives this exec's caller. When the argv starts with `timeout` and
 * the command timed out, the rest of its process group is killed too:
 * `timeout` stops escalating once its direct child exits, which can leave a
 * TERM-ignoring descendant running.
 *
 * The result follows on the wrapper's own streams: stderr's first line is
 * `<exit> <stdout bytes> <stderr bytes>`, followed by the stderr tail;
 * stdout is the stdout tail. The record is removed only once the result was
 * written out.
 */
const RUN_SCRIPT = `dir=$1; cap=$2; cwd=$3; shift 3
mkdir -- "$dir" 2>/dev/null || exit ${RECORD_ID_IN_USE_EXIT}
cat /proc/sys/kernel/random/boot_id >"$dir/boot" 2>/dev/null
setsid -w sh -c 'echo "$$" >"$0/pid"; cd -- "$1" || exit 1; shift; exec "$@"' "$dir" "$cwd" "$@" </dev/null >"$dir/stdout" 2>"$dir/stderr"
code=$?
if [ "$1" = timeout ] && { [ "$code" = 124 ] || [ "$code" = 137 ]; }; then
  kill -s KILL -- "-$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null
fi
echo "$code" >"$dir/exit.tmp" && mv -- "$dir/exit.tmp" "$dir/exit"
so=$(stat -c %s "$dir/stdout" 2>/dev/null) || so=0
se=$(stat -c %s "$dir/stderr" 2>/dev/null) || se=0
printf '%s %s %s\\n' "$code" "$so" "$se" >&2 &&
  tail -c "$cap" "$dir/stderr" >&2 &&
  tail -c "$cap" "$dir/stdout" &&
  rm -rf -- "$dir"`;

/** Kills a record's process group, waiting briefly for a just-started command to write its pid. */
const KILL_SCRIPT = `d=$1; i=0
while [ ! -s "$d/pid" ]; do
  [ -e "$d/exit" ] && exit 0
  i=$((i+1)); [ "$i" -gt 100 ] && exit 0
  sleep 0.02
done
kill -s KILL -- "-$(cat "$d/pid")" 2>/dev/null
exit 0`;

/**
 * Sweeps records and prints how many are still running. Finished records
 * nobody collected expire; running records past the orphan ceiling are
 * killed; dead records without an exit code are removed.
 */
const SWEEP_SCRIPT = `root=$1; ceiling=$2; ttl=$3
now=$(date +%s); boot=$(cat /proc/sys/kernel/random/boot_id); n=0
for d in "$root"/*/; do
  [ -d "$d" ] || continue
  d=\${d%/}
  age=$(( now - $(stat -c %Y "$d") ))
  if [ -e "$d/exit" ]; then
    [ "$age" -gt "$ttl" ] && rm -rf -- "$d"
    continue
  fi
  pid=$(cat "$d/pid" 2>/dev/null)
  state=""
  [ -n "$pid" ] && [ "$(cat "$d/boot" 2>/dev/null)" = "$boot" ] && state=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -c1)
  if [ -n "$state" ] && [ "$state" != Z ]; then
    if [ "$age" -gt "$ceiling" ]; then kill -s KILL -- "-$pid" 2>/dev/null; rm -rf -- "$d"; else n=$((n+1)); fi
  elif [ "$age" -gt 60 ]; then
    rm -rf -- "$d"
  fi
done
echo "$n"`;

/** Runs on every container start: records from an earlier boot are stale. */
const PREPARE_SCRIPT = `root=$1; shift
rm -rf -- "$root" && mkdir -p -- "$root" && { [ "$#" -eq 0 ] || mkdir -p -- "$@"; }`;

const READ_SCRIPT = `s=$(stat -L -c %s -- "$1") || exit 1
[ "$s" -le "$2" ] || { echo "file is $s bytes, above the $2-byte read limit" >&2; exit 3; }
exec cat -- "$1"`;

const WRITE_SCRIPT = 'cat > "$1"';

const STAT_SCRIPT = 'stat -L -c "%s/%Y/%F" -- "$1" && stat -c "%F" -- "$1"';

const decoder = new TextDecoder();

function script(name: string, body: string, ...args: string[]): string[] {
	return ['sh', '-c', body, `flue-${name}`, ...args];
}

function recordDir(cmdId: string): string {
	return `${EXEC_ROOT}/${cmdId}`;
}

// ─── Records ────────────────────────────────────────────────────────────────

/** Reset the record root and create the attached working directories. */
export function prepareArgv(cwds: readonly string[]): string[] {
	return script('prepare', PREPARE_SCRIPT, EXEC_ROOT, ...cwds);
}

/** Run `command` (bash) as record `cmdId`, from a clean environment, and print its result. */
export function runArgv(cmdId: string, command: string, options: RpcRunOptions): string[] {
	const timeout =
		options.timeoutMs !== undefined && options.timeoutMs > 0
			? ['timeout', '--kill-after=5', `${Math.ceil(options.timeoutMs) / 1000}s`]
			: [];
	return script(
		'run',
		RUN_SCRIPT,
		recordDir(cmdId),
		String(OUTPUT_TAIL_BYTES),
		options.cwd,
		...timeout,
		'env',
		'-i',
		...envAssignments({ ...BASELINE_ENV, ...options.env }),
		'bash',
		'-c',
		command,
	);
}

/** The command's result from the run wrapper's output, or `undefined` when the wrapper died before printing it. */
export function parseRun(result: ExecResult): RpcShellResult | undefined {
	const newline = result.stderr.indexOf('\n');
	if (newline === -1) return undefined;
	const [code = '', stdoutBytes = '0', stderrBytes = '0'] = result.stderr
		.slice(0, newline)
		.split(' ');
	if (!/^\d+$/.test(code)) return undefined;
	const stderr = result.stderr.slice(newline + 1);
	return {
		stdout: withTruncationNote(decoder.decode(result.stdout), Number(stdoutBytes)),
		stderr: withTruncationNote(stderr, Number(stderrBytes)),
		exitCode: Number(code),
	};
}

export function killArgv(cmdId: string): string[] {
	return script('kill', KILL_SCRIPT, recordDir(cmdId));
}

export function sweepArgv(): string[] {
	return script(
		'sweep',
		SWEEP_SCRIPT,
		EXEC_ROOT,
		String(ORPHAN_CEILING_S),
		String(UNCOLLECTED_TTL_S),
	);
}

/** How many records are still running. */
export function parseSweep(result: ExecResult): number {
	return Number(decoder.decode(result.stdout).trim());
}

// ─── Files ──────────────────────────────────────────────────────────────────

export function readFileArgv(path: string): string[] {
	return script('read', READ_SCRIPT, path, String(FILE_READ_LIMIT_BYTES));
}

/** Write stdin to `path`, byte for byte. */
export function writeFileArgv(path: string): string[] {
	return script('write', WRITE_SCRIPT, path);
}

export function statArgv(path: string): string[] {
	return script('stat', STAT_SCRIPT, path);
}

export function parseStat(result: ExecResult): RpcFileStat {
	const [target = '', self = ''] = decoder.decode(result.stdout).trim().split('\n');
	const [size = '0', mtime = '0', type = ''] = target.split('/');
	return {
		isFile: type.includes('regular'),
		isDirectory: type === 'directory',
		isSymbolicLink: self.trim() === 'symbolic link',
		size: Number(size),
		mtimeMs: Number(mtime) * 1000,
	};
}

export function readdirArgv(path: string): string[] {
	return ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0'];
}

export function parseReaddir(result: ExecResult): string[] {
	return decoder
		.decode(result.stdout)
		.split('\0')
		.filter((name) => name.length > 0);
}

/** Exits 0 when `path` exists, 1 when it does not. */
export function existsArgv(path: string): string[] {
	return ['test', '-e', path];
}

export function mkdirArgv(path: string, recursive: boolean): string[] {
	return ['mkdir', ...(recursive ? ['-p'] : []), '--', path];
}

export function rmArgv(path: string, recursive: boolean, force: boolean): string[] {
	return ['rm', ...(recursive ? ['-r'] : []), ...(force ? ['-f'] : []), '--', path];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function envAssignments(env: Record<string, string>): string[] {
	return Object.entries(env).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`[flue] Invalid sandbox environment variable name "${key}".`);
		}
		return `${key}=${value}`;
	});
}

function withTruncationNote(text: string, totalBytes: number): string {
	if (!(totalBytes > OUTPUT_TAIL_BYTES)) return text;
	return `[flue: output truncated to the last ${OUTPUT_TAIL_BYTES} of ${totalBytes} bytes]\n${text}`;
}
