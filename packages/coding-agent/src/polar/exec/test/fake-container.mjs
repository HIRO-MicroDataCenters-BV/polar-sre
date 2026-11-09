#!/usr/bin/env node
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

const OOM_LINE =
	"[    0.694] Memory cgroup out of memory: Killed process 129 (python3) total-vm:3158408kB, anon-rss:1046208kB";

async function run(args) {
	if (knob("RUN_FAILS") === "1") fail("failed to create container: image not found");
	const { options, command } = parseRun(args);
	const id = options["--name"];
	if (!options.switches.has("--interactive") && !options.switches.has("-i")) {
		if (id !== undefined && !options.switches.has("--rm")) {
			writeContainer({ id, labels: options.labels, state: "stopped", pid: null, bootLog: [], command });
		}
		process.exit(Number(knob("CHOWN_EXIT", 0)));
	}
	const record = { id, labels: options.labels, state: "running", pid: process.pid, bootLog: [], command };
	writeContainer(record);
	process.on("SIGTERM", () => {
		record.state = "stopped";
		if (existsSync(containerPath(id))) writeContainer(record);
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
			case "echo_argv":
				process.stdout.write(`${JSON.stringify({ argv, codeLength: code.length })}\n`);
				break;
			case "oom":
				record.bootLog.push(OOM_LINE);
				exitCode = 137;
				break;
			case "exit137":
				exitCode = 137;
				break;
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
		record.state = "stopped";
		if (existsSync(containerPath(id))) writeContainer(record);
		process.exit(exitCode);
	}, delayMs);
}

function signalRecorded(record, signal) {
	if (typeof record.pid !== "number" || record.pid <= 0) return;
	try {
		process.kill(record.pid, signal);
	} catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const [command, ...args] = argv;
	switch (command) {
		case "system":
			process.exit(Number(knob("STATUS_EXIT", 0)));
			break;
		case "image":
			if (knob("IMAGE_MISSING") === "1") fail(`image ${args[1]} not found`);
			process.stdout.write(`[{"id":"${args[1]}"}]\n`);
			break;
		case "run":
			return run(args);
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
