#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const stateRoot = process.env.FAKE_OCI_STATE ?? process.env.FAKE_CONTAINER_STATE;
if (!stateRoot) {
	process.stderr.write("FAKE_OCI_STATE is not set\n");
	process.exit(64);
}
const knob = (name, fallback) =>
	process.env[`FAKE_OCI_${name}`] ?? process.env[`FAKE_CONTAINER_${name}`] ?? fallback;
const containersDir = join(stateRoot, "containers");
const volumesDir = join(stateRoot, "volumes");
mkdirSync(containersDir, { recursive: true });
mkdirSync(volumesDir, { recursive: true });

const engine = knob("ENGINE", "podman");
const argv = process.argv.slice(2);
appendFileSync(join(stateRoot, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

const fail = (message, code = 1) => {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(code);
};

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function listJson(directory) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJson(join(directory, name)));
}

function containerPath(id) {
	return join(containersDir, `${id}.json`);
}

function volumePath(name) {
	return join(volumesDir, `${name}.json`);
}

const SWITCHES = new Set(["--init", "--read-only", "--interactive", "-i", "--rm", "--all", "-a", "--force", "-f", "--detach", "-d"]);

function parseRun(args) {
	const options = { labels: {}, filters: [], switches: new Set() };
	const rest = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg.startsWith("-")) {
			rest.push(...args.slice(index));
			break;
		}
		if (SWITCHES.has(arg)) {
			options.switches.add(arg);
			continue;
		}
		if (arg.includes("=")) {
			const eq = arg.indexOf("=");
			const flag = arg.slice(0, eq);
			const value = arg.slice(eq + 1);
			if (flag === "--label" || flag === "-l") {
				const [key, ...valueParts] = value.split("=");
				options.labels[key] = valueParts.join("=");
			} else if (flag === "--filter") {
				options.filters.push(value);
			} else {
				options[flag] = value;
			}
			continue;
		}
		const value = args[index + 1];
		index += 1;
		if (arg === "--label" || arg === "-l") {
			const [key, ...valueParts] = value.split("=");
			options.labels[key] = valueParts.join("=");
		} else if (arg === "--filter") {
			options.filters.push(value);
		} else {
			options[arg] = value;
		}
	}
	return { options, image: rest[0], command: rest.slice(1), rest };
}

function matchesLabelFilters(labels, filters) {
	for (const filter of filters) {
		if (!filter.startsWith("label=")) continue;
		const expr = filter.slice("label=".length);
		const eq = expr.indexOf("=");
		if (eq === -1) {
			if (!(expr in (labels ?? {}))) return false;
		} else {
			const key = expr.slice(0, eq);
			const value = expr.slice(eq + 1);
			if ((labels ?? {})[key] !== value) return false;
		}
	}
	return true;
}

function writeContainer(record) {
	writeFileSync(containerPath(record.id), JSON.stringify(record));
}

function readStdin() {
	return new Promise((resolve) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

function signalPid(pid, signal) {
	if (typeof pid !== "number" || pid <= 0) return;
	try {
		process.kill(pid, signal);
	} catch {}
}

function signalRecorded(record, signal) {
	signalPid(record.execPid, signal);
	signalPid(record.pid, signal);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function handleInfo() {
	if (engine === "podman" && knob("PODMAN_FAIL") === "1") {
		fail(knob("PODMAN_FAIL_MESSAGE", "podman info failed"));
	}
	const exit = Number(knob("INFO_EXIT", knob("STATUS_EXIT", 0)));
	if (exit !== 0) fail(`${engine} daemon is not running`, exit);
	if (knob("INFO_GARBAGE") === "1") {
		process.stdout.write("not json\n");
		return;
	}
	if (engine === "docker") {
		const serverError = knob("DOCKER_SERVER_ERROR");
		if (serverError !== undefined) {
			process.stdout.write(`${JSON.stringify({ ServerErrors: [serverError] })}\n`);
			return;
		}
		const rootless = knob("DOCKER_ROOTLESS") === "1";
		const securityOptions = rootless
			? ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"]
			: ["name=seccomp,profile=builtin", "name=cgroupns"];
		const defaultRuntime = knob("OCI_RUNTIME", "runc");
		const runtimesJson = knob("DOCKER_RUNTIMES_JSON");
		const runtimes = runtimesJson ? JSON.parse(runtimesJson) : { runc: {}, runsc: {}, krun: {} };
		process.stdout.write(
			`${JSON.stringify({
				ServerVersion: "28.5.2",
				SecurityOptions: securityOptions,
				DefaultRuntime: defaultRuntime,
				Runtimes: runtimes,
			})}\n`,
		);
		return;
	}
	const rootless = knob("PODMAN_ROOTLESS", "1") !== "0";
	const cpuDelegated = knob("CPU_DELEGATED", "1") !== "0";
	const controllers = cpuDelegated ? ["cpu", "memory", "pids"] : ["memory", "pids"];
	const ociRuntime = knob("OCI_RUNTIME", "crun");
	const ociRuntimePath = knob("OCI_RUNTIME_PATH", `/usr/bin/${ociRuntime}`);
	const version = knob("PODMAN_VERSION", "5.4.0");
	process.stdout.write(
		`${JSON.stringify({
			host: {
				security: { rootless },
				cgroupControllers: controllers,
				ociRuntime: { name: ociRuntime, path: ociRuntimePath },
			},
			version: { Version: version },
		})}\n`,
	);
}

async function run(args) {
	if (knob("RUN_HANG") === "1") await sleep(60_000);
	if (knob("RUN_FAILS") === "1") fail("failed to create container: image not found");
	const { options, command } = parseRun(args);
	const id = options["--name"];
	if (!options.switches.has("--interactive") && !options.switches.has("-i")) {
		if (id !== undefined && !options.switches.has("--rm")) {
			writeContainer({
				id,
				labels: options.labels,
				state: options.switches.has("--detach") || options.switches.has("-d") ? "running" : "exited",
				pid: null,
				execPid: null,
				oomKillCount: 0,
				oomKilled: false,
				command,
				runArgv: argv,
			});
		}
		process.exit(Number(knob("CHOWN_EXIT", 0)));
	}
	const record = {
		id,
		labels: options.labels,
		state: "running",
		pid: process.pid,
		execPid: null,
		oomKillCount: 0,
		oomKilled: false,
		command,
		runArgv: argv,
	};
	writeContainer(record);
	const timer = setInterval(() => {
		if (!existsSync(stateRoot)) process.exit(0);
	}, 50);
	process.on("SIGTERM", () => {
		clearInterval(timer);
		if (existsSync(containerPath(id))) {
			const current = readJson(containerPath(id));
			current.state = "exited";
			writeContainer(current);
		}
		process.exit(137);
	});
	process.stdin.on("data", () => {});
	process.stdin.on("end", () => {
		clearInterval(timer);
		if (existsSync(containerPath(id))) {
			const current = readJson(containerPath(id));
			current.state = "exited";
			writeContainer(current);
		}
		process.exit(0);
	});
	process.stdout.write("\n");
}

async function execCommand(args) {
	const { options, image: id, command } = parseRun(args);
	if (!existsSync(containerPath(id))) fail(`no such container: ${id}`);
	const initial = readJson(containerPath(id));
	if (initial.state !== "running") fail(`container ${id} is not running`);
	if (!options.switches.has("--interactive") && !options.switches.has("-i")) {
		if (command[0] === "cat" && command[1] === "/sys/fs/cgroup/memory.events") {
			if (knob("MEMORY_EVENTS_FAIL") === "1") {
				fail("cat: /sys/fs/cgroup/memory.events: No such file or directory");
			}
			if (knob("MEMORY_EVENTS_NO_OOM_KILL") === "1") {
				process.stdout.write("low 0\nhigh 0\nmax 0\n");
				process.exit(0);
			}
			const count = initial.oomKillCount ?? 0;
			process.stdout.write(`low 0\nhigh 0\nmax 0\noom 0\noom_kill ${count}\noom_group_kill 0\n`);
			process.exit(0);
		}
		if (knob("SCRUB_HANG") === "1") await sleep(60_000);
		if (knob("SCRUB_FAIL") === "1") process.exit(1);
		process.exit(0);
	}
	if (knob("EXEC_FAILS") === "1") fail("exec failed");
	initial.execPid = process.pid;
	writeContainer(initial);
	process.on("SIGTERM", () => {
		process.exit(137);
	});
	const code = await readStdin();
	let exitCode = 0;
	let delayMs = 0;
	let hang = false;
	for (const line of code.split("\n")) {
		const [directive, ...valueParts] = line.split(":");
		const value = valueParts.join(":");
		switch (directive) {
			case "stdout":
				process.stdout.write(`${value}\n`);
				break;
			case "stderr":
				process.stderr.write(`${value}\n`);
				break;
			case "stdout_bytes":
				process.stdout.write("x".repeat(Number(value)));
				break;
			case "stdout_lines":
				for (let index = 1; index <= Number(value); index += 1) process.stdout.write(`line ${index}\n`);
				break;
			case "exit":
				exitCode = Number(value);
				break;
			case "delay_ms":
				delayMs = Number(value);
				break;
			case "sleep_ms":
				await sleep(Number(value));
				break;
			case "echo_argv": {
				const current = existsSync(containerPath(id)) ? readJson(containerPath(id)) : initial;
				process.stdout.write(
					`${JSON.stringify({ argv, runArgv: current.runArgv, codeLength: code.length })}\n`,
				);
				break;
			}
			case "oom": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.oomKillCount = (current.oomKillCount ?? 0) + 1;
					current.oomKilled = true;
					writeContainer(current);
				}
				exitCode = 137;
				break;
			}
			case "oom_container_died": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "exited";
					current.oomKilled = true;
					writeContainer(current);
					signalPid(current.pid, "SIGKILL");
				}
				exitCode = 137;
				break;
			}
			case "oom_gvisor_128": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "exited";
					current.oomKilled = true;
					writeContainer(current);
					signalPid(current.pid, "SIGKILL");
				}
				exitCode = 128;
				break;
			}
			case "oom_survived": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.oomKillCount = (current.oomKillCount ?? 0) + 1;
					current.oomKilled = true;
					writeContainer(current);
				}
				break;
			}
			case "work_limit":
				exitCode = 199;
				break;
			case "exit137":
				exitCode = 137;
				break;
			case "exit128":
				exitCode = 128;
				break;
			case "vanish": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "exited";
					writeContainer(current);
					signalPid(current.pid, "SIGKILL");
				}
				exitCode = 137;
				break;
			}
			case "hang":
				hang = true;
				break;
			default:
				break;
		}
	}
	if (hang) {
		setInterval(() => {}, 1000);
		return;
	}
	setTimeout(() => {
		if (existsSync(containerPath(id))) {
			const current = readJson(containerPath(id));
			current.execPid = null;
			writeContainer(current);
		}
		process.stdout.end(() => {
			process.stderr.end(() => {
				process.exit(exitCode);
			});
		});
	}, delayMs);
}

function inspectEntry(record) {
	return {
		Id: record.id,
		Name: `/${record.id}`,
		Config: { Labels: record.labels ?? {} },
		State: {
			Status: record.state,
			Running: record.state === "running",
			OOMKilled: Boolean(record.oomKilled),
		},
	};
}

async function main() {
	const [command, ...args] = argv;
	switch (command) {
		case "info":
			handleInfo();
			break;
		case "image": {
			const [sub, img] = args;
			if (sub === "pull") {
				if (knob("PULL_FAIL") === "1") fail(`pull ${img} failed`);
				process.stdout.write(`pulled ${img}\n`);
				break;
			}
			const present = knob("IMAGE_PRESENT");
			if (knob("IMAGE_MISSING") === "1" || (present !== undefined && present !== img)) {
				fail(`image ${img} not found`);
			}
			process.stdout.write(`[{"Id":"${img}"}]\n`);
			break;
		}
		case "pull": {
			const [img] = args;
			if (knob("PULL_FAIL") === "1") fail(`pull ${img} failed`);
			process.stdout.write(`pulled ${img}\n`);
			break;
		}
		case "build":
			if (knob("BUILD_FAIL") === "1") fail("build failed");
			process.stdout.write("built\n");
			break;
		case "run":
			return run(args);
		case "exec":
			return execCommand(args);
		case "kill": {
			const id = args.at(-1);
			await sleep(Number(knob("KILL_DELAY_MS", 0)));
			if (!existsSync(containerPath(id))) fail(`no such container: ${id}`);
			if (knob("RUN_IGNORES_KILL") !== "1") signalRecorded(readJson(containerPath(id)), "SIGTERM");
			break;
		}
		case "rm":
		case "delete":
			if (knob("DELETE_HANG") === "1") await sleep(60_000);
			await sleep(Number(knob("DELETE_DELAY_MS", 0)));
			if (knob("DELETE_FAIL") === "1") fail(knob("DELETE_FAIL_MESSAGE", "runtime temporarily unavailable"));
			for (const id of args.filter((arg) => !arg.startsWith("-"))) {
				if (!existsSync(containerPath(id))) continue;
				signalRecorded(readJson(containerPath(id)), "SIGKILL");
				rmSync(containerPath(id), { force: true });
			}
			if (knob("DELETE_GHOST") === "1") fail("delete reported an error after the container went");
			break;
		case "ps": {
			if (knob("LIST_FAIL") === "1" || knob("PS_FAIL") === "1") fail("list failed");
			if (knob("LIST_GARBAGE") === "1" || knob("PS_GARBAGE") === "1") {
				process.stdout.write("not valid names\n");
				break;
			}
			const { options } = parseRun(args);
			const containers = listJson(containersDir).filter((record) =>
				matchesLabelFilters(record.labels, options.filters),
			);
			for (const record of containers) {
				process.stdout.write(`${record.id}\n`);
			}
			break;
		}
		case "inspect": {
			if (knob("INSPECT_HANG") === "1") await sleep(60_000);
			const exit = Number(knob("INSPECT_EXIT", 0));
			if (exit !== 0) fail("inspect failed", exit);
			if (knob("INSPECT_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				break;
			}
			if (knob("INSPECT_JSON") !== undefined) {
				process.stdout.write(knob("INSPECT_JSON"));
				break;
			}
			const ids = args.filter((arg) => !arg.startsWith("-"));
			const entries = [];
			for (const id of ids) {
				if (knob("INSPECT_MISSING") === "1" || !existsSync(containerPath(id))) {
					fail(`no such container: ${id}`);
				}
				entries.push(inspectEntry(readJson(containerPath(id))));
			}
			process.stdout.write(`${JSON.stringify(entries)}\n`);
			break;
		}
		case "volume":
			return volume(args);
		default:
			fail(`unknown command ${command}`, 64);
	}
}

function volumeEntry(record) {
	return {
		Name: record.name,
		Labels: record.labels ?? {},
	};
}

function volume(args) {
	const [sub, ...rest] = args;
	switch (sub) {
		case "ls":
		case "list": {
			const { options } = parseRun(rest);
			const volumes = listJson(volumesDir).filter((record) =>
				matchesLabelFilters(record.labels, options.filters),
			);
			for (const record of volumes) {
				process.stdout.write(`${record.name}\n`);
			}
			break;
		}
		case "inspect": {
			const exit = Number(knob("VOLUME_INSPECT_EXIT", 0));
			if (exit !== 0) fail("volume inspect failed", exit);
			if (knob("VOLUME_INSPECT_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				break;
			}
			const names = rest.filter((arg) => !arg.startsWith("-"));
			const entries = [];
			for (const name of names) {
				if (!existsSync(volumePath(name))) fail(`no such volume: ${name}`);
				entries.push(volumeEntry(readJson(volumePath(name))));
			}
			process.stdout.write(`${JSON.stringify(entries)}\n`);
			break;
		}
		case "create": {
			const exit = Number(knob("VOLUME_CREATE_EXIT", 0));
			if (exit !== 0) fail("volume create failed", exit);
			const { options } = parseRun(rest.slice(0, -1));
			const name = rest.at(-1);
			writeFileSync(volumePath(name), JSON.stringify({ name, labels: options.labels, size: "4G" }));
			process.stdout.write(`${name}\n`);
			break;
		}
		case "rm":
		case "delete": {
			const name = rest.at(-1);
			if (knob("VOLUME_IN_USE") === name) fail(`volume '${name}' is currently in use`);
			if (existsSync(volumePath(name))) {
				const owner = readJson(volumePath(name)).labels?.["polar-session"];
				const mounted = listJson(containersDir).some(
					(record) => owner !== undefined && record.labels?.["polar-session"] === owner,
				);
				if (mounted) fail(`volume '${name}' is currently in use`);
			}
			rmSync(volumePath(name), { force: true });
			break;
		}
		default:
			fail(`unknown volume command ${sub}`, 64);
	}
}

await main();
