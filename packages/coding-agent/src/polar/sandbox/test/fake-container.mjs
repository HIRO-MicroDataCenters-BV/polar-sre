#!/usr/bin/env node
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const stateRoot = process.env.FAKE_CONTAINER_STATE;
if (!stateRoot) {
	process.stderr.write("FAKE_CONTAINER_STATE is not set\n");
	process.exit(64);
}
const knob = (name, fallback) => process.env[`FAKE_CONTAINER_${name}`] ?? fallback;
const containersDir = join(stateRoot, "containers");
const volumesDir = join(stateRoot, "volumes");
const systemStatePath = join(stateRoot, "system.json");
const imagesStatePath = join(stateRoot, "images.json");
mkdirSync(containersDir, { recursive: true });
mkdirSync(volumesDir, { recursive: true });

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

function readSystemState() {
	const persisted = existsSync(systemStatePath) ? readJson(systemStatePath) : {};
	const defaultStatus = knob("SERVICE_STATUS", knob("SERVICE_STOPPED") === "1" ? "unregistered" : "running");
	const defaultKernel = knob("KERNEL_MISSING") !== "1";
	return {
		status: persisted.status ?? defaultStatus,
		kernelConfigured: persisted.kernelConfigured ?? defaultKernel,
	};
}

function writeSystemState(patch) {
	const current = existsSync(systemStatePath) ? readJson(systemStatePath) : {};
	writeFileSync(systemStatePath, JSON.stringify({ ...current, ...patch }));
}

function recordedImages() {
	if (!existsSync(imagesStatePath)) return new Set();
	return new Set(readJson(imagesStatePath));
}

function recordImage(image) {
	if (typeof image !== "string" || image === "") return;
	const images = recordedImages();
	images.add(image);
	writeFileSync(imagesStatePath, JSON.stringify([...images]));
}

function maybeSpawnStdoutHolder(knobName) {
	if (knob(knobName) !== "1" && knob("SPAWN_HOLDER") !== "1") return;
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], {
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (child.pid !== undefined) {
		appendFileSync(join(stateRoot, "holders.jsonl"), `${JSON.stringify(child.pid)}\n`);
	}
}

const SWITCHES = new Set(["--init", "--read-only", "--interactive", "-i", "--rm", "--all", "-a", "--force", "-f"]);

function parseRun(args) {
	const options = { labels: {}, switches: new Set() };
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
		const value = args[index + 1];
		index += 1;
		if (arg === "--label" || arg === "-l") {
			const [key, ...valueParts] = value.split("=");
			options.labels[key] = valueParts.join("=");
		} else {
			options[arg] = value;
		}
	}
	return { options, image: rest[0], command: rest.slice(1) };
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

const OOM_LINE =
	"[    0.694] Memory cgroup out of memory: Killed process 129 (python3) total-vm:3158408kB, anon-rss:1046208kB";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireRunningService() {
	if (readSystemState().status !== "running") {
		fail("XPC connection error: Connection invalid. Did you run 'container system start'?");
	}
}

async function run(args) {
	if (knob("RUN_HANG") === "1") await sleep(60_000);
	requireRunningService();
	const sys = readSystemState();
	if (!sys.kernelConfigured) {
		fail(
			"default kernel not configured for architecture arm64, please use the `container system kernel set` command to configure it",
		);
	}
	if (knob("RUN_FAILS") === "1") fail("failed to create container: image not found");
	const { options, command } = parseRun(args);
	const id = options["--name"];
	if (!options.switches.has("--interactive") && !options.switches.has("-i")) {
		if (id !== undefined && !options.switches.has("--rm")) {
			writeContainer({
				id,
				labels: options.labels,
				state: "stopped",
				pid: null,
				execPid: null,
				bootLog: [],
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
		bootLog: [],
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
			current.state = "stopped";
			writeContainer(current);
		}
		process.exit(137);
	});
	process.stdin.on("data", () => {});
	process.stdin.on("end", () => {
		clearInterval(timer);
		if (existsSync(containerPath(id))) {
			const current = readJson(containerPath(id));
			current.state = "stopped";
			writeContainer(current);
		}
		process.exit(0);
	});
	process.stdout.write("\n");
}

async function execCommand(args) {
	const { options, image: id } = parseRun(args);
	if (!existsSync(containerPath(id))) fail(`container not found: ${id}`);
	const initial = readJson(containerPath(id));
	if (initial.state !== "running") fail(`container ${id} is not running`);
	if (!options.switches.has("--interactive") && !options.switches.has("-i")) {
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
					current.bootLog.push(OOM_LINE);
					writeContainer(current);
				}
				exitCode = 137;
				break;
			}
			case "oom_survived": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.bootLog.push(OOM_LINE);
					writeContainer(current);
				}
				break;
			}
			case "exit137":
				exitCode = 137;
				break;
			case "vanish": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "stopped";
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

async function handleSystem(args) {
	const [sub, ...rest] = args;
	if (sub === "start") {
		maybeSpawnStdoutHolder("START_SPAWN_HOLDER");
		if (knob("START_HANG") === "1") await sleep(60_000);
		if (knob("START_FAIL") === "1") fail(knob("START_FAIL_MESSAGE", "system start failed"));
		const sys = readSystemState();
		const enableKernel = rest.includes("--enable-kernel-install");
		const disableKernel = rest.includes("--disable-kernel-install");
		const nextKernel = enableKernel ? true : disableKernel ? sys.kernelConfigured : sys.kernelConfigured;
		process.stderr.write("Launching container-apiserver...\n");
		process.stderr.write("Testing access to container-apiserver...\n");
		process.stderr.write("Verifying machine API server is running...\n");
		if (enableKernel && !sys.kernelConfigured) {
			process.stderr.write("Installing kernel...\n");
		}
		writeSystemState({ status: "running", kernelConfigured: nextKernel });
		process.exit(0);
	}
	if (sub === "stop") {
		writeSystemState({ status: "unregistered" });
		process.exit(0);
	}
	if (knob("STATUS_HANG") === "1") await sleep(60_000);
	const statusExitKnob = knob("STATUS_EXIT");
	const exitCode = Number(statusExitKnob ?? 0);
	if (knob("STATUS_GARBAGE") === "1") {
		process.stdout.write("not json\n");
		process.exit(exitCode);
	}
	if (knob("STATUS_JSON") !== undefined) {
		process.stdout.write(`${knob("STATUS_JSON")}\n`);
		process.exit(exitCode);
	}
	if (statusExitKnob !== undefined && exitCode !== 0 && knob("SERVICE_STATUS") === undefined && knob("SERVICE_STOPPED") === undefined) {
		fail(knob("STATUS_FAIL_MESSAGE", `exit ${exitCode}`), exitCode);
	}
	const sys = readSystemState();
	const jsonFormat = rest.includes("--format") && rest[rest.indexOf("--format") + 1] === "json";
	if (sys.status === "unregistered" || sys.status === "not running") {
		if (jsonFormat) {
			process.stdout.write(`${JSON.stringify({ status: sys.status })}\n`);
		} else {
			process.stderr.write("apiserver is not running and not registered with launchd\n");
		}
		process.exit(statusExitKnob !== undefined ? exitCode : 1);
	}
	const clientVersion = knob("CLIENT_VERSION", knob("VERSION", "1.7.1"));
	const serverVersion = knob("SERVER_VERSION", knob("VERSION", "1.7.1"));
	if (jsonFormat) {
		process.stdout.write(
			`${JSON.stringify({
				client: { appName: "container", build: "release", version: clientVersion },
				host: { architecture: "arm64", cpus: 8, operatingSystem: "Version 26.5.1 (Build 25F80)" },
				paths: { appRoot: "/tmp/com.apple.container/", installRoot: "/usr/local/" },
				resources: { containersRunning: 0, containersTotal: 0, images: 1 },
				server: { appName: "container-apiserver", build: "release", version: serverVersion },
				status: sys.status,
			})}\n`,
		);
	}
	process.exit(exitCode);
}

function handleVersion() {
	if (knob("VERSION_FAIL") === "1") fail(knob("VERSION_FAIL_MESSAGE", "version failed"));
	if (knob("VERSION_STDOUT") !== undefined) {
		process.stdout.write(`${knob("VERSION_STDOUT")}\n`);
		process.exit(0);
	}
	const clientVersion = knob("CLIENT_VERSION", knob("VERSION", "1.7.1"));
	process.stdout.write(`container CLI version ${clientVersion} (build: release, commit: a15b460)\n`);
	process.exit(0);
}

async function main() {
	const [command, ...args] = argv;
	switch (command) {
		case "--version":
		case "version":
			handleVersion();
			break;
		case "system":
			await handleSystem(args);
			break;
		case "image": {
			requireRunningService();
			const sub = args[0];
			const img = args.at(-1);
			if (sub === "pull") {
				maybeSpawnStdoutHolder("PULL_SPAWN_HOLDER");
				if (knob("PULL_HANG") === "1") await sleep(60_000);
				if (knob("PULL_FAIL") === "1") fail(`pull ${img} failed`);
				recordImage(img);
				process.stdout.write(`pulled ${img}\n`);
				break;
			}
			if (recordedImages().has(img)) {
				process.stdout.write(`[{"id":"${img}"}]\n`);
				break;
			}
			const present = knob("IMAGE_PRESENT");
			if (knob("IMAGE_MISSING") === "1" || (present !== undefined && present !== img)) {
				fail(`image ${img} not found`);
			}
			process.stdout.write(`[{"id":"${img}"}]\n`);
			break;
		}
		case "build": {
			requireRunningService();
			maybeSpawnStdoutHolder("BUILD_SPAWN_HOLDER");
			if (knob("BUILD_HANG") === "1") await sleep(60_000);
			if (knob("BUILD_FAIL") === "1") fail("build failed");
			const { options } = parseRun(args);
			recordImage(options["--tag"] ?? options["-t"]);
			process.stdout.write("built\n");
			break;
		}
		case "run":
			return run(args);
		case "exec":
			return execCommand(args);
		case "kill": {
			const id = args.at(-1);
			await sleep(Number(knob("KILL_DELAY_MS", 0)));
			if (!existsSync(containerPath(id))) fail(`container ${id} not found`);
			if (knob("RUN_IGNORES_KILL") !== "1") signalRecorded(readJson(containerPath(id)), "SIGTERM");
			break;
		}
		case "delete":
		case "rm":
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
		case "list":
		case "ls": {
			if (knob("LIST_FAIL") === "1") fail("list failed");
			if (knob("LIST_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				break;
			}
			if (knob("LIST_JSON") !== undefined) {
				process.stdout.write(knob("LIST_JSON"));
				break;
			}
			const listing = listJson(containersDir).map((record) => ({
				configuration: { id: record.id, labels: record.labels },
				id: record.id,
				status: { state: record.state },
			}));
			process.stdout.write(`${JSON.stringify(listing)}\n`);
			break;
		}
		case "inspect": {
			const id = args.at(-1);
			if (knob("INSPECT_HANG") === "1") await sleep(60_000);
			const exit = Number(knob("INSPECT_EXIT", 0));
			if (exit !== 0) fail("inspect failed", exit);
			if (knob("INSPECT_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				break;
			}
			if (knob("INSPECT_MISSING") === "1" || !existsSync(containerPath(id))) fail(`container not found: ${id}`);
			const record = readJson(containerPath(id));
			process.stdout.write(
				`${JSON.stringify([{ id, configuration: { id, labels: record.labels }, status: { state: record.state } }])}\n`,
			);
			break;
		}
		case "logs": {
			const id = args.at(-1);
			if (knob("LOGS_FAIL") === "1") fail("logs failed");
			if (!existsSync(containerPath(id))) fail(`container ${id} not found`);
			process.stdout.write(`${["boot...", ...readJson(containerPath(id)).bootLog].join("\n")}\n`);
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
		configuration: { labels: record.labels, name: record.name, options: { size: record.size } },
		id: record.name,
	};
}

function volume(args) {
	const [sub, ...rest] = args;
	switch (sub) {
		case "list":
		case "ls": {
			process.stdout.write(`${JSON.stringify(listJson(volumesDir).map(volumeEntry))}\n`);
			break;
		}
		case "inspect": {
			const name = rest.at(-1);
			const exit = Number(knob("VOLUME_INSPECT_EXIT", 0));
			if (exit !== 0) fail("volume inspect failed", exit);
			if (knob("VOLUME_INSPECT_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				break;
			}
			if (!existsSync(volumePath(name))) fail(`volume not found: ${name}`);
			process.stdout.write(`${JSON.stringify([volumeEntry(readJson(volumePath(name)))])}\n`);
			break;
		}
		case "create": {
			const exit = Number(knob("VOLUME_CREATE_EXIT", 0));
			if (exit !== 0) fail("volume create failed", exit);
			const { options } = parseRun(rest.slice(0, -1));
			const name = rest.at(-1);
			writeFileSync(volumePath(name), JSON.stringify({ name, labels: options.labels, size: options["-s"] }));
			process.stdout.write(`${name}\n`);
			break;
		}
		case "delete":
		case "rm": {
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
