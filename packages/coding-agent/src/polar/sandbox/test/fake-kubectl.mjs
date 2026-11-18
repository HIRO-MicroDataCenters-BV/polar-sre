#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const stateRoot = process.env.FAKE_KUBECTL_STATE ?? process.env.FAKE_CONTAINER_STATE;
if (!stateRoot) {
	process.stderr.write("FAKE_KUBECTL_STATE is not set\n");
	process.exit(64);
}
const knob = (name, fallback) =>
	process.env[`FAKE_KUBECTL_${name}`] ?? process.env[`FAKE_CONTAINER_${name}`] ?? fallback;
const containersDir = join(stateRoot, "containers");
const volumesDir = join(stateRoot, "volumes");
mkdirSync(containersDir, { recursive: true });
mkdirSync(volumesDir, { recursive: true });

const argv = process.argv.slice(2);
appendFileSync(join(stateRoot, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

const fail = (message, code = 1) => {
	process.stderr.write(`${message}\n`);
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

function parseGlobalFlags(args) {
	let kubeconfig;
	let namespace = "polar";
	const rest = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i));
			break;
		}
		if (arg === "--kubeconfig") {
			kubeconfig = args[i + 1];
			i += 1;
		} else if (arg.startsWith("--kubeconfig=")) {
			kubeconfig = arg.slice("--kubeconfig=".length);
		} else if (arg === "-n" || arg === "--namespace") {
			namespace = args[i + 1];
			i += 1;
		} else if (arg.startsWith("--namespace=")) {
			namespace = arg.slice("--namespace=".length);
		} else {
			rest.push(arg);
		}
	}
	return { kubeconfig, namespace, rest };
}

function verifyKubeconfig(kubeconfig) {
	if (knob("ALLOW_ENV_KUBECONFIG") !== "1" && process.env.KUBECONFIG !== undefined) {
		fail(`error: unexpected KUBECONFIG in environment: ${process.env.KUBECONFIG}`);
	}
	if (knob("AUTH_FAIL") === "1") {
		fail("Error from server (Unauthorized): Unauthorized");
	}
	if (knob("SKIP_KUBECONFIG_CHECK") === "1") return;
	if (!kubeconfig || !existsSync(kubeconfig)) {
		fail(`error: stat ${kubeconfig ?? ""}: no such file or directory`);
	}
	try {
		const parsed = readJson(kubeconfig);
		const user = parsed?.users?.[0]?.user;
		const tokenFile = user?.tokenFile;
		const token =
			typeof tokenFile === "string" && existsSync(tokenFile)
				? readFileSync(tokenFile, "utf8").trim()
				: user?.token;
		if (!token) fail("Error from server (Unauthorized): missing token");
	} catch {
		fail("error: error loading config file");
	}
}

function matchesSelector(labels, selector) {
	if (!selector) return true;
	for (const part of selector.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (!(trimmed in (labels ?? {}))) return false;
		} else {
			const key = trimmed.slice(0, eq);
			const value = trimmed.slice(eq + 1);
			if ((labels ?? {})[key] !== value) return false;
		}
	}
	return true;
}

function materializePodStatus(record) {
	if (typeof record.oomLagPollsRemaining === "number" && record.oomLagPollsRemaining > 0) {
		record.oomLagPollsRemaining -= 1;
		writeContainer(record);
		return {
			phase: "Running",
			containerState: {
				running: {
					startedAt: record.startedAt ?? "2026-11-16T20:59:14Z",
				},
			},
			ready: true,
		};
	}
	if (record.oomKilled && record.state !== "running") {
		record.phase = "Failed";
		record.terminated = {
			containerID: "containerd://6844c74b2051ae728f4dd37f90f3fe99b8f7497319a961a993b3002c516ded1e",
			exitCode: 137,
			finishedAt: "2026-11-16T20:59:21Z",
			reason: "OOMKilled",
			startedAt: record.startedAt ?? "2026-11-16T20:59:14Z",
		};
		writeContainer(record);
	}
	if (record.waiting !== undefined) {
		return {
			phase: "Pending",
			containerState: { waiting: record.waiting },
			ready: false,
		};
	}
	if (record.state === "running") {
		return {
			phase: "Running",
			containerState: {
				running: {
					startedAt: record.startedAt ?? "2026-11-16T20:32:10Z",
				},
			},
			ready: true,
		};
	}
	const terminated = record.terminated ?? {
		containerID: "containerd://accfbfb797050f7c6dc16c378ed1917c7eb7f1f82ded17687f16eb452b02b061",
		exitCode: record.exitCode ?? 0,
		finishedAt: "2026-11-16T20:37:56Z",
		reason: record.oomKilled ? "OOMKilled" : (record.terminatedReason ?? "Completed"),
		startedAt: record.startedAt ?? "2026-11-16T20:32:10Z",
	};
	const phase = record.phase ?? (terminated.exitCode === 0 ? "Succeeded" : "Failed");
	return {
		phase,
		containerState: { terminated },
		ready: false,
	};
}

function renderPodJson(record, namespace) {
	const { phase, containerState, ready } = materializePodStatus(record);
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: record.id,
			namespace: record.namespace ?? namespace,
			uid: record.uid ?? `uid-${record.id}`,
			labels: record.labels ?? {},
			annotations: record.annotations ?? {},
			...(record.ownerReferences ? { ownerReferences: record.ownerReferences } : {}),
		},
		spec: record.spec ?? {},
		status: {
			phase,
			qosClass: "Burstable",
			startTime: record.startedAt ?? "2026-11-16T20:32:09Z",
			containerStatuses: [
				{
					name: "sandbox",
					image: record.image ?? "polar-sandbox:0.2",
					imageID: "sha256:6ae0521015a5e58750f8eab9b41f8c152e4d3b1251e6be1224f569d603792994",
					containerID: "containerd://accfbfb797050f7c6dc16c378ed1917c7eb7f1f82ded17687f16eb452b02b061",
					lastState: {},
					ready,
					restartCount: 0,
					started: ready,
					state: containerState,
				},
			],
		},
	};
}

async function handleCreate(args, namespace) {
	if (knob("RUN_HANG") === "1" || knob("CREATE_HANG") === "1") await sleep(60_000);
	if (knob("RUN_FAILS") === "1" || knob("CREATE_FAIL") === "1") {
		fail(knob("CREATE_FAIL_MESSAGE", "Error from server (Forbidden): pods is forbidden"));
	}
	const fIndex = args.indexOf("-f");
	const manifestPath = fIndex !== -1 ? args[fIndex + 1] : undefined;
	if (!manifestPath || !existsSync(manifestPath)) {
		fail("error: must specify -f");
	}
	const manifest = readJson(manifestPath);
	appendFileSync(join(stateRoot, "manifests.jsonl"), `${JSON.stringify(manifest)}\n`);
	const metadata = manifest.metadata ?? {};
	const spec = manifest.spec ?? {};
	const container = spec.containers?.[0] ?? {};
	const id = metadata.name;
	const command = container.command ?? [];
	const labels = metadata.labels ?? {};
	const annotations = metadata.annotations ?? {};
	const ownerReferences = metadata.ownerReferences;
	const startedAt = "2026-11-16T20:32:10Z";

	// Check if this pod mounts subPath: work/<sessionId> -> kubelet auto-creates work/<sessionId>
	const workMount = (container.volumeMounts ?? []).find((m) => m.mountPath === "/work" && typeof m.subPath === "string");
	if (workMount && workMount.subPath.startsWith("work/")) {
		const sessionId = workMount.subPath.slice("work/".length);
		const volName = `polar-work-${sessionId}`;
		if (!existsSync(volumePath(volName))) {
			writeFileSync(
				volumePath(volName),
				JSON.stringify({
					name: volName,
					sessionId,
					labels: {
						"polar-session": sessionId,
						...(annotations["polar-root"] ? { "polar-root": annotations["polar-root"] } : {}),
					},
					size: "4G",
				}),
			);
		}
	}

	// Check if this is the NetworkPolicy + /work probe pod
	if (command[0] === "python3" && typeof command[2] === "string" && command[2].includes("socket.create_connection")) {
		if (knob("NETPROBE_CREATE_FAIL") === "1") {
			fail("Error from server: failed to create netprobe pod");
		}
		if (knob("NETPROBE_HANG") === "1") {
			writeContainer({
				id,
				namespace: metadata.namespace ?? namespace,
				labels,
				annotations,
				ownerReferences,
				spec,
				manifest,
				state: "running",
				phase: "Running",
				startedAt,
				pid: null,
				execPid: null,
			});
			process.stdout.write(`pod/${id} created\n`);
			return;
		}
		const hasWritableWorkMount = Boolean(workMount && workMount.readOnly !== true && workMount.subPath?.startsWith("work/"));
		const workWriteFail = knob("WORK_PROBE_FAIL") === "1" || !hasWritableWorkMount;
		const allowEgress = knob("NETPOLICY_ALLOW") === "1";
		const exitCode = workWriteFail ? 2 : allowEgress ? 1 : Number(knob("NETPOLICY_EXIT", 0));
		writeContainer({
			id,
			namespace: metadata.namespace ?? namespace,
			labels,
			annotations,
			ownerReferences,
			spec,
			manifest,
			state: "stopped",
			phase: exitCode === 0 ? "Succeeded" : "Failed",
			exitCode,
			terminatedReason: exitCode === 0 ? "Completed" : "Error",
			startedAt,
			pid: null,
			execPid: null,
		});
		process.stdout.write(`pod/${id} created\n`);
		return;
	}

	// Check if this is the work cleanup pod (polar-work-rm)
	if (command[3] === "polar-work-rm") {
		const targetSessionIds = command.slice(4);
		const workRootMount = (container.volumeMounts ?? []).find(
			(m) => m.mountPath === "/work-root" && m.subPath === "work" && m.readOnly !== true,
		);
		if (workRootMount) {
			for (const targetSessionId of targetSessionIds) {
				if (targetSessionId) {
					rmSync(volumePath(`polar-work-${targetSessionId}`), { force: true });
				}
			}
		}
		writeContainer({
			id,
			namespace: metadata.namespace ?? namespace,
			labels,
			annotations,
			ownerReferences,
			spec,
			manifest,
			state: "stopped",
			phase: workRootMount ? "Succeeded" : "Failed",
			exitCode: workRootMount ? 0 : 1,
			terminatedReason: workRootMount ? "Completed" : "Error",
			startedAt,
			pid: null,
			execPid: null,
		});
		process.stdout.write(`pod/${id} created\n`);
		return;
	}

	const waitingReason = knob("POD_WAITING_REASON");
	if (waitingReason) {
		writeContainer({
			id,
			namespace: metadata.namespace ?? namespace,
			labels,
			annotations,
			ownerReferences,
			spec,
			manifest,
			state: "waiting",
			phase: "Pending",
			waiting: {
				reason: waitingReason,
				message: knob("POD_WAITING_MESSAGE", "Back-off pulling image"),
			},
			startedAt,
			pid: null,
			execPid: null,
		});
		process.stdout.write(`pod/${id} created\n`);
		return;
	}

	writeContainer({
		id,
		namespace: metadata.namespace ?? namespace,
		labels,
		annotations,
		ownerReferences,
		spec,
		manifest,
		image: container.image,
		state: "running",
		phase: "Running",
		startedAt,
		pid: null,
		execPid: null,
		oomKillCount: 0,
		oomKilled: false,
	});
	process.stdout.write(`pod/${id} created\n`);
}

async function handleGet(args, namespace) {
	if (knob("INSPECT_HANG") === "1") await sleep(60_000);
	const resource = args[0];
	if (resource === "pods") {
		if (knob("LIST_FAIL") === "1") fail("Error from server: list pods failed");
		if (knob("LIST_GARBAGE") === "1") {
			process.stdout.write("not json\n");
			return;
		}
		if (knob("LIST_JSON") !== undefined) {
			process.stdout.write(knob("LIST_JSON"));
			return;
		}
		const lIndex = args.indexOf("-l");
		const selector = lIndex !== -1 ? args[lIndex + 1] : "";
		const items = listJson(containersDir)
			.filter((record) => matchesSelector(record.labels, selector))
			.map((record) => renderPodJson(record, namespace));
		process.stdout.write(`${JSON.stringify({ apiVersion: "v1", kind: "List", items })}\n`);
		return;
	}
	if (resource === "pod") {
		const name = args[1];
		const exit = Number(knob("INSPECT_EXIT", 0));
		if (exit !== 0) fail("Error from server: inspect pod failed", exit);
		if (knob("INSPECT_GARBAGE") === "1") {
			process.stdout.write("not json\n");
			return;
		}
		const selfPodName = process.env.POLAR_SANDBOX_K8S_POD_NAME || "polar-0";
		if (name === selfPodName && !existsSync(containerPath(name))) {
			if (knob("SELF_POD_MISSING") === "1") {
				fail(`Error from server (NotFound): pods "${name}" not found`);
			}
			if (knob("SELF_POD_GARBAGE") === "1") {
				process.stdout.write("not json\n");
				return;
			}
			const uid = knob("SELF_POD_UID", process.env.POLAR_SANDBOX_K8S_POD_UID || "uid-polar-0");
			process.stdout.write(
				`${JSON.stringify({
					apiVersion: "v1",
					kind: "Pod",
					metadata: { name, namespace, uid },
					status: { phase: "Running", containerStatuses: [{ name: "polar", ready: true, state: { running: {} } }] },
				})}\n`,
			);
			return;
		}
		if (knob("INSPECT_MISSING") === "1" || !existsSync(containerPath(name))) {
			fail(`Error from server (NotFound): pods "${name}" not found`);
		}
		const record = readJson(containerPath(name));
		process.stdout.write(`${JSON.stringify(renderPodJson(record, namespace))}\n`);
		return;
	}
	fail(`error: the server doesn't have a resource type "${resource}"`);
}

async function handleDelete(args, namespace) {
	if (knob("DELETE_HANG") === "1") await sleep(60_000);
	await sleep(Number(knob("DELETE_DELAY_MS", 0)));
	const names = args.slice(1).filter((arg) => !arg.startsWith("-"));
	for (const id of names) {
		if (id.startsWith("polar-netprobe-") && knob("NETPROBE_DELETE_FAIL") === "1") {
			fail("Error from server: netprobe delete failed");
		}
	}
	if (knob("DELETE_FAIL") === "1") {
		fail(knob("DELETE_FAIL_MESSAGE", "Error from server: runtime temporarily unavailable"));
	}
	for (const id of names) {
		if (!existsSync(containerPath(id))) {
			fail(`Error from server (NotFound): pods "${id}" not found`);
		}
		const record = readJson(containerPath(id));
		if (knob("RUN_IGNORES_KILL") !== "1") {
			signalRecorded(record, "SIGKILL");
		}
		rmSync(containerPath(id), { force: true });
		if (knob("DELETE_GHOST") === "1") {
			fail("Error from server: delete reported an error after the pod went");
		}
		process.stdout.write(`pod "${id}" deleted from ${namespace} namespace\n`);
	}
}

async function handleExec(args) {
	const dashDash = args.indexOf("--");
	const beforeDash = dashDash === -1 ? args : args.slice(0, dashDash);
	const command = dashDash === -1 ? [] : args.slice(dashDash + 1);
	const interactive = beforeDash.includes("-i") || beforeDash.includes("--interactive");
	const id = beforeDash.find((arg) => !arg.startsWith("-"));
	if (!id || !existsSync(containerPath(id))) {
		fail(`Error from server (NotFound): pods "${id ?? ""}" not found`);
	}
	const initial = readJson(containerPath(id));
	if (initial.state !== "running") {
		if (initial.phase === "Running" || (initial.oomLagPollsRemaining ?? 0) > 0) {
			fail('error: unable to upgrade connection: container not found ("sandbox")');
		}
		fail(`error: cannot exec into a container in a completed pod; current phase is ${initial.phase ?? "Failed"}`);
	}
	if (!interactive) {
		if (command[0] === "ls" && command[1] === "-1" && command[2] === "/work-root") {
			for (const vol of listJson(volumesDir)) {
				const sessionId =
					vol.sessionId ??
					vol.labels?.["polar-session"] ??
					(typeof vol.name === "string" ? vol.name.replace(/^polar-work-/, "") : "");
				if (sessionId) process.stdout.write(`${sessionId}\n`);
			}
			process.exit(0);
		}
		if (command[0] === "bash" && command[1] === "-c" && command[2]?.includes("/sys/fs/cgroup/memory.events")) {
			const hasCgroupEvents = knob("CGROUP_MEMORY_EVENTS", "0") === "1" || (initial.oomKillCount ?? 0) > 0;
			if (hasCgroupEvents) {
				const count = initial.oomKillCount ?? 0;
				process.stdout.write(`low 0\nhigh 0\nmax 0\noom 0\noom_kill ${count}\noom_group_kill 0\n`);
			}
			process.exit(0);
		}
		if (knob("SCRUB_HANG") === "1") await sleep(60_000);
		if (knob("SCRUB_FAIL") === "1") {
			process.stderr.write("command terminated with exit code 1\n");
			process.exit(1);
		}
		process.exit(0);
	}

	if (knob("EXEC_FAILS") === "1") fail("error: unable to upgrade connection: exec failed");
	initial.execPid = process.pid;
	writeContainer(initial);
	process.on("SIGTERM", () => {
		process.stderr.write("command terminated with exit code 137\n");
		process.exit(137);
	});
	const code = await readStdin();
	let exitCode = 0;
	let delayMs = 0;
	let hang = false;
	let suppressDefaultTrailer = false;
	for (const line of code.split("\n")) {
		const [directive, ...valueParts] = line.split(":");
		const value = valueParts.join(":");
		switch (directive) {
			case "stdout":
				process.stdout.write(`${value}\n`);
				break;
			case "stdout_raw":
				process.stdout.write(value);
				break;
			case "stderr":
				process.stderr.write(`${value}\n`);
				break;
			case "stderr_raw":
				process.stderr.write(value);
				break;
			case "stderr_chunked_trailer": {
				const [chunkSizeStr, codeStr, ...payloadParts] = value.split(":");
				const chunkSize = Math.max(1, Number(chunkSizeStr));
				exitCode = Number(codeStr);
				suppressDefaultTrailer = true;
				const full = Buffer.from(
					`${payloadParts.join(":")}command terminated with exit code ${exitCode}\n`,
					"utf8",
				);
				for (let offset = 0; offset < full.length; offset += chunkSize) {
					process.stderr.write(full.subarray(offset, Math.min(full.length, offset + chunkSize)));
					await sleep(5);
				}
				break;
			}
			case "stdout_bytes":
				process.stdout.write("x".repeat(Number(value)));
				break;
			case "stdout_lines":
				for (let index = 1; index <= Number(value); index += 1) process.stdout.write(`line ${index}\n`);
				break;
			case "exit":
				exitCode = Number(value);
				break;
			case "exit137":
				exitCode = 137;
				break;
			case "exit128":
				exitCode = 128;
				break;
			case "work_limit":
				exitCode = 199;
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
					`${JSON.stringify({ argv, manifest: current.manifest, codeLength: code.length })}\n`,
				);
				break;
			}
			case "oom":
			case "oom_gvisor_128": {
				process.stderr.write(
					'waiting on pid 14: waiting on PID 14 in sandbox "9482238a12775c1c0f2880e732e72e48004e2adea42737f6ab0de8c8cdd00f36": urpc method "containerManager.WaitPID" failed: EOF\n',
				);
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "stopped";
					current.oomKilled = true;
					const lagPolls = Number(knob("OOM_LAG_POLLS", 0));
					current.oomLagPollsRemaining = lagPolls;
					current.phase = lagPolls > 0 ? "Running" : "Failed";
					writeContainer(current);
				}
				exitCode = 128;
				break;
			}
			case "oom_gvisor_137": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "stopped";
					current.oomKilled = true;
					const lagPolls = Number(knob("OOM_LAG_POLLS", 0));
					current.oomLagPollsRemaining = lagPolls;
					current.phase = lagPolls > 0 ? "Running" : "Failed";
					writeContainer(current);
				}
				exitCode = 137;
				break;
			}
			case "oom_cgroup": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.oomKillCount = (current.oomKillCount ?? 0) + 1;
					writeContainer(current);
				}
				exitCode = 137;
				break;
			}
			case "oom_survived": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.oomKillCount = (current.oomKillCount ?? 0) + 1;
					writeContainer(current);
				}
				break;
			}
			case "vanish": {
				if (existsSync(containerPath(id))) {
					const current = readJson(containerPath(id));
					current.state = "stopped";
					current.phase = "Failed";
					current.exitCode = 137;
					current.terminatedReason = "Error";
					writeContainer(current);
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
		if (exitCode !== 0 && !suppressDefaultTrailer) {
			process.stderr.write(`command terminated with exit code ${exitCode}\n`);
		}
		process.stdout.end(() => {
			process.stderr.end(() => {
				process.exit(exitCode);
			});
		});
	}, delayMs);
}

async function main() {
	const { kubeconfig, namespace, rest } = parseGlobalFlags(argv);
	verifyKubeconfig(kubeconfig);
	const [command, ...args] = rest;
	switch (command) {
		case "logs": {
			const podName = args.find((arg) => !arg.startsWith("-")) ?? "";
			fail(
				`Error from server (Forbidden): pods "${podName}" is forbidden: User "system:serviceaccount:${namespace}:polar" cannot get resource "pods/log" in API group "" in the namespace "${namespace}"`,
			);
			break;
		}
		case "create":
			await handleCreate(args, namespace);
			break;
		case "get":
			await handleGet(args, namespace);
			break;
		case "delete":
			await handleDelete(args, namespace);
			break;
		case "exec":
			await handleExec(args);
			break;
		default:
			fail(`error: unknown command "${command}"`, 64);
	}
}

await main();
