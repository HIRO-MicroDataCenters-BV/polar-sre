#!/usr/bin/env node
// For `kubectl --kubeconfig=<path> config view --output=json`:
// - Reads `<path>` from disk and prints its content to stdout (exit 0).
// - If `<path>` starts with `EXIT:<code>:<stderr>`, writes `<stderr>` to stderr and exits with `<code>`.
// - If `<path>` does not exist, writes an error to stderr and exits with 1.
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";

const setting = (name, fallback) => process.env[`FAKE_KUBECTL_${name}`] ?? fallback;

if (setting("IGNORE_SIGTERM") === "1") {
	process.on("SIGTERM", () => {});
}

const args = process.argv.slice(2);
const isConfigView = args.includes("config") && args.includes("view") && args.includes("--output=json");

if (isConfigView) {
	const flag = args.find((arg) => arg.startsWith("--kubeconfig="));
	const kubeconfigPath = flag ? flag.slice("--kubeconfig=".length) : (process.env.KUBECONFIG ?? "");
	const delayMs = Number(setting("CONFIG_DELAY_MS", 0));

	setTimeout(() => {
		if (kubeconfigPath && existsSync(kubeconfigPath)) {
			const content = readFileSync(kubeconfigPath, "utf8");
			const exitMatch = /^EXIT:(\d+):([\s\S]*)$/.exec(content);
			if (exitMatch) {
				process.stderr.write(exitMatch[2]);
				process.exitCode = Number(exitMatch[1]);
			} else {
				process.stdout.write(content);
				process.exitCode = 0;
			}
			return;
		}
		process.stderr.write(`error: open ${kubeconfigPath}: no such file or directory\n`);
		process.exitCode = 1;
	}, delayMs);
} else {
	if (setting("ECHO") === "1") {
		const alsoEchoed = setting("ECHO_ALSO", "").split(",");
		const relevant = ([name]) =>
			name === "KUBECONFIG" || name === "KUBERC" || name.startsWith("KUBECTL_") || alsoEchoed.includes(name);
		const environment = Object.fromEntries(Object.entries(process.env).filter(relevant));
		process.stdout.write(`${JSON.stringify({ argv: args, environment })}\n`);
	}

	const after = (delayMs, write) => (delayMs > 0 ? setTimeout(write, delayMs) : write());

	after(Number(setting("STDOUT_DELAY_MS", 0)), () => {
		const stdout = setting("STDOUT");
		if (stdout !== undefined) process.stdout.write(stdout);
		const stdoutBytes = Number(setting("STDOUT_BYTES", 0));
		if (stdoutBytes > 0) process.stdout.write("x".repeat(stdoutBytes));
	});

	after(Number(setting("STDERR_DELAY_MS", 0)), () => {
		const stderr = setting("STDERR");
		if (stderr !== undefined) process.stderr.write(stderr);
	});

	if (setting("CHILD") === "1") {
		const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], {
			stdio: setting("CHILD_INHERITS") === "1" ? "inherit" : "ignore",
			detached: setting("CHILD_DETACHED") === "1",
		});
		process.stdout.write(`child-pid ${child.pid}\n`);
	}

	setTimeout(
		() => {
			process.exitCode = Number(setting("EXIT", 0));
		},
		Number(setting("DELAY_MS", 0)),
	);
}
