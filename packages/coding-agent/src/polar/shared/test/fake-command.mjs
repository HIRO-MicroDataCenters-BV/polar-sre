#!/usr/bin/env node
import { spawn } from "child_process";

const setting = (name, fallback) => process.env[`FAKE_COMMAND_${name}`] ?? fallback;

if (setting("IGNORE_SIGTERM") === "1") {
	process.on("SIGTERM", () => {});
}

if (setting("ECHO") === "1") {
	const alsoEchoed = setting("ECHO_ALSO", "").split(",").filter(Boolean);
	const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => alsoEchoed.includes(name)));
	process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2), environment })}\n`);
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
