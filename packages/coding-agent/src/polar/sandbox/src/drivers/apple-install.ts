import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { chmod, mkdir, open, readdir, rename, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAgentDir } from "../../../../config.ts";
import { truncateTail } from "../../../../core/tools/truncate.ts";
import {
	boundDiagnostic,
	commandFailure,
	containerCommand,
	DIAGNOSTIC_MAX_BYTES,
	DIAGNOSTIC_MAX_LINES,
	firstLine,
	StreamCapture,
} from "../cli.ts";
import type { ActionIO, ActionResult, SandboxDriverContext, SetupAction } from "../types.ts";
import { COMMAND_STDERR_MAX_BYTES, isVersionAtLeast } from "./shared.ts";

const PINNED_CONTAINER_VERSION = "1.7.1";
const PINNED_CONTAINER_PKG_NAME = `container-${PINNED_CONTAINER_VERSION}-installer-signed.pkg`;
const PINNED_CONTAINER_PKG_URL = `https://github.com/apple/container/releases/download/${PINNED_CONTAINER_VERSION}/${PINNED_CONTAINER_PKG_NAME}`;
const PINNED_CONTAINER_PKG_SIZE_BYTES = 169_630_704;
const PINNED_CONTAINER_PKG_SHA256 = "b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97";
const PINNED_CONTAINER_TEAM_ID = "UPBK2H6LZM";
const MIN_INSTALL_MACOS_MAJOR = 26;

const INSTALL_CONTAINER_OPTION = "Install and set up";
export const INSTALL_CONTAINER_OUTLOOK = `Download and install Apple container ${PINNED_CONTAINER_VERSION} — 170 MB, signed by Apple. Asks for your macOS password.`;

const INSTALL_CONTAINER_INSTRUCTIONS = [
	"Install Apple container (>= 1.5.0) from https://github.com/apple/container/releases",
	"container system start --enable-kernel-install",
];

const DEFAULT_SYSCTL_PATH = "/usr/sbin/sysctl";
const DEFAULT_SW_VERS_PATH = "/usr/bin/sw_vers";
const DEFAULT_PKGUTIL_PATH = "/usr/sbin/pkgutil";
const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_INSTALLER_PATH = "/usr/sbin/installer";
const INSTALL_SUBDIR = "container-install";

export interface AppleInstallOptions {
	pkgUrl?: string;
	pkgSha256?: string;
	teamId?: string;
	sysctlPath?: string;
	swVersPath?: string;
	pkgutilPath?: string;
	sudoPath?: string;
	installerPath?: string;
	writeStdout?: (chunk: string | Buffer) => void;
	writeStderr?: (chunk: string | Buffer) => void;
}

type AppleInstallPlatformProbe =
	| { kind: "installable" }
	| { kind: "unsupported"; reason: string }
	| { kind: "manual"; instructions: string[] };

function appleInstallPreview(pkgUrl = PINNED_CONTAINER_PKG_URL): string[] {
	return [
		`curl -fLo ${PINNED_CONTAINER_PKG_NAME} ${pkgUrl}`,
		`sudo installer -pkg ${PINNED_CONTAINER_PKG_NAME} -target /`,
		"container system start --enable-kernel-install",
	];
}

function buildInstallerEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
	};
	for (const key of ["HOME", "USER", "LOGNAME", "TERM"] as const) {
		const value = sourceEnv[key];
		if (typeof value === "string" && value !== "") {
			env[key] = value;
		}
	}
	return env;
}

export async function probeAppleInstallPlatform(
	runtime: SandboxDriverContext,
	options?: AppleInstallOptions,
): Promise<AppleInstallPlatformProbe> {
	const sysctlPath = options?.sysctlPath ?? DEFAULT_SYSCTL_PATH;
	const sysctl = await containerCommand(runtime, ["-n", "hw.optional.arm64"], { command: sysctlPath });
	if (sysctl.code !== 0 || sysctl.stdout.trim() !== "1") {
		return { kind: "unsupported", reason: "Apple container requires Apple silicon (arm64)" };
	}

	const swVersPath = options?.swVersPath ?? DEFAULT_SW_VERS_PATH;
	const swVers = await containerCommand(runtime, ["-productVersion"], { command: swVersPath });
	const productVersion = firstLine(swVers.stdout);
	if (swVers.code !== 0 || productVersion === "" || !isVersionAtLeast(productVersion, MIN_INSTALL_MACOS_MAJOR, 0)) {
		const requirement =
			swVers.code === 0 && productVersion !== ""
				? `Automatic installation requires macOS ${MIN_INSTALL_MACOS_MAJOR} or later (found ${productVersion})`
				: `Automatic installation requires macOS ${MIN_INSTALL_MACOS_MAJOR} or later`;
		return {
			kind: "manual",
			instructions: [requirement, ...INSTALL_CONTAINER_INSTRUCTIONS],
		};
	}

	return { kind: "installable" };
}

async function cleanInstallDirectory(installDir: string): Promise<void> {
	const entries = await readdir(installDir).catch(() => []);
	for (const entry of entries) {
		if (entry.endsWith(".pkg") || entry.endsWith(".pkg.part")) {
			await rm(join(installDir, entry), { force: true }).catch(() => {});
		}
	}
}

interface InstallerRunOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	output: string;
	spawnError?: string;
}

async function runSignedPkgInstaller(
	pkgPath: string,
	sourceEnv: NodeJS.ProcessEnv,
	options: {
		sudoPath: string;
		installerPath: string;
		teamId: string;
		sha256: string;
		writeStdout: (chunk: string | Buffer) => void;
		writeStderr: (chunk: string | Buffer) => void;
	},
): Promise<InstallerRunOutcome> {
	const shortHash = `${options.sha256.slice(0, 8)}…${options.sha256.slice(-4)}`;
	const banner = [
		"Polar is paused. macOS asks for your password to install Apple container.",
		`Verified: signed by Apple Inc. (${options.teamId}), SHA-256 ${shortHash}`,
		`$ sudo installer -pkg ${pkgPath} -target /`,
		"",
	].join("\n");
	options.writeStdout(banner);

	const onSigint = () => {};
	process.on("SIGINT", onSigint);
	try {
		return await new Promise<InstallerRunOutcome>((resolve) => {
			const outputCapture = new StreamCapture(COMMAND_STDERR_MAX_BYTES);
			const child = spawn(options.sudoPath, ["--", options.installerPath, "-pkg", pkgPath, "-target", "/"], {
				cwd: tmpdir(),
				env: buildInstallerEnv(sourceEnv),
				stdio: ["inherit", "pipe", "pipe"],
			});
			let settled = false;
			const finish = (outcome: InstallerRunOutcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
			child.stdout.on("data", (chunk: Buffer) => {
				outputCapture.retain(chunk);
				options.writeStdout(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				outputCapture.retain(chunk);
				options.writeStderr(chunk);
			});
			child.once("error", (error: NodeJS.ErrnoException) => {
				finish({
					code: null,
					signal: null,
					output: boundDiagnostic(error.message),
					spawnError: error.code ?? error.message,
				});
			});
			child.once("close", (code, signal) => {
				const tail = truncateTail(outputCapture.text().trim(), {
					maxBytes: DIAGNOSTIC_MAX_BYTES,
					maxLines: DIAGNOSTIC_MAX_LINES,
				});
				finish({
					code,
					signal,
					output: tail.content,
				});
			});
		});
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

export function createInstallRuntimeAction(runtime: SandboxDriverContext, options?: AppleInstallOptions): SetupAction {
	const pkgUrl = options?.pkgUrl ?? PINNED_CONTAINER_PKG_URL;
	const expectedSha256 = (options?.pkgSha256 ?? PINNED_CONTAINER_PKG_SHA256).toLowerCase();
	const teamId = options?.teamId ?? PINNED_CONTAINER_TEAM_ID;
	const pkgutilPath = options?.pkgutilPath ?? DEFAULT_PKGUTIL_PATH;
	const installerPath = options?.installerPath ?? DEFAULT_INSTALLER_PATH;
	const sudoPath = options?.sudoPath ?? DEFAULT_SUDO_PATH;
	const writeStdout = options?.writeStdout ?? ((chunk: string | Buffer) => process.stdout.write(chunk));
	const writeStderr = options?.writeStderr ?? ((chunk: string | Buffer) => process.stderr.write(chunk));
	const preview = appleInstallPreview(pkgUrl);

	return {
		id: "install_runtime",
		label: INSTALL_CONTAINER_OPTION,
		title: `Installing Apple container ${PINNED_CONTAINER_VERSION}`,
		preview,
		mode: "foreground",
		run: async (io: ActionIO): Promise<ActionResult> => {
			if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
			if (io.handoffTerminal === undefined) {
				return {
					ok: false,
					reason: `terminal handoff is required to install Apple container\n${preview.join("\n")}`,
				};
			}
			const handoffTerminal = io.handoffTerminal;

			const installDir = join(getAgentDir(), INSTALL_SUBDIR);
			await mkdir(installDir, { recursive: true, mode: 0o700 });
			await chmod(installDir, 0o700).catch(() => {});
			await cleanInstallDirectory(installDir);

			const partPath = join(installDir, `${randomBytes(8).toString("hex")}.pkg.part`);
			const pkgPath = join(installDir, PINNED_CONTAINER_PKG_NAME);
			try {
				let response: Response;
				try {
					response = await fetch(pkgUrl, { signal: io.signal });
				} catch (error) {
					if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
					const reason = error instanceof Error ? error.message : String(error);
					return { ok: false, reason: `failed to download Apple container installer: ${reason}` };
				}
				if (!response.ok || response.body === null) {
					return {
						ok: false,
						reason: `failed to download Apple container installer: HTTP ${response.status}`,
					};
				}

				const rawLength = response.headers.get("content-length");
				const parsedLength = rawLength !== null ? Number(rawLength) : Number.NaN;
				const totalBytes =
					Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : PINNED_CONTAINER_PKG_SIZE_BYTES;

				const hash = createHash("sha256");
				let doneBytes = 0;
				io.onDownloadProgress?.(0, totalBytes);

				const handle = await open(partPath, "wx", 0o600);
				try {
					const reader = response.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (io.signal.aborted) {
							await reader.cancel().catch(() => {});
							return { ok: false, cancelled: true, reason: "cancelled" };
						}
						const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
						hash.update(buffer);
						let offset = 0;
						while (offset < buffer.byteLength) {
							const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
							offset += bytesWritten;
						}
						doneBytes += buffer.byteLength;
						io.onDownloadProgress?.(doneBytes, totalBytes);
					}
				} catch (error) {
					if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
					const reason = error instanceof Error ? error.message : String(error);
					return { ok: false, reason: `failed to download Apple container installer: ${reason}` };
				} finally {
					await handle.close().catch(() => {});
				}

				if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };

				const actualSha256 = hash.digest("hex").toLowerCase();
				if (actualSha256 !== expectedSha256) {
					return {
						ok: false,
						reason: `Apple container installer SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256})`,
					};
				}

				await rename(partPath, pkgPath);

				const sigOutcome = await containerCommand(runtime, ["--check-signature", pkgPath], {
					command: pkgutilPath,
					signal: io.signal,
				});
				if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
				if (sigOutcome.code !== 0) {
					const stdout = sigOutcome.stdout.trim();
					const detail =
						!sigOutcome.timedOut && sigOutcome.stderr.trim() === "" && stdout !== ""
							? boundDiagnostic(stdout)
							: commandFailure(sigOutcome);
					return {
						ok: false,
						reason: `Apple container installer signature verification failed: ${detail}`,
					};
				}
				const sigText = `${sigOutcome.stdout}\n${sigOutcome.stderr}`;
				if (
					!sigText
						.split(/\r?\n/)
						.some((line) => line.includes("Developer ID Installer") && line.includes(`(${teamId})`))
				) {
					return {
						ok: false,
						reason: `Apple container installer signature did not match Team ID ${teamId}`,
					};
				}

				let installOutcome: InstallerRunOutcome;
				try {
					installOutcome = await handoffTerminal(() =>
						runSignedPkgInstaller(pkgPath, runtime.environment, {
							sudoPath,
							installerPath,
							teamId,
							sha256: expectedSha256,
							writeStdout,
							writeStderr,
						}),
					);
				} catch (error) {
					if (io.signal.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
					const reason = error instanceof Error ? error.message : String(error);
					return { ok: false, reason };
				}

				const summary =
					installOutcome.output !== ""
						? installOutcome.output
						: installOutcome.signal !== null
							? `terminated by ${installOutcome.signal}`
							: installOutcome.code !== 0
								? `exit ${String(installOutcome.code)}`
								: "";
				const detail = summary !== "" ? `${summary}\n${preview.join("\n")}` : preview.join("\n");
				return { ok: true, detail };
			} finally {
				await rm(partPath, { force: true }).catch(() => {});
				await rm(pkgPath, { force: true }).catch(() => {});
			}
		},
	};
}
