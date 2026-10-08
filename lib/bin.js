#!/usr/bin/env node
import { G as WorkBuddyCredentialStore, S as WorkBuddyUpstreamClient, X as workBuddyOwnAuthPath, a as readHostHeartbeat, c as WORKBUDDY_VERSION, d as FALLBACK_WORKBUDDY_MODELS, o as workBuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, u as WorkBuddyOAuthLogin, x as workBuddyProductConfigPath, y as loadProductConfig } from "./host-heartbeat-CTDXTjmj.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy <doctor|status|login|logout> [--json]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  login    open the WorkBuddy website and save tokens to the plugin-owned copy",
		"  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)",
		"  --json   emit one secret-free JSON document (doctor/status only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function makeStore() {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
}
async function doctor(jsonOutput) {
	const store = makeStore();
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const product = loadProductConfig();
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy",
		version: WORKBUDDY_VERSION,
		node: process.version,
		desktopAuthFile: {
			path: store.desktopAuthPath() ?? `(no platform default; set WORKBUDDY_AUTH_FILE)`,
			present: desktopPresent
		},
		ownAuthFile: workBuddyOwnAuthPath(),
		productConfig: {
			path: product.path ?? workBuddyProductConfigPath(),
			source: product.source,
			freeModels: product.source === "cache" ? product.models.filter((model) => model.credits !== void 0 && /^x?0(?:\.0+)?$/u.test(model.credits)).map((model) => model.id) : FALLBACK_WORKBUDDY_MODELS.map((model) => model.id)
		},
		hostHeartbeat: {
			path: workBuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		fallbackModels: FALLBACK_WORKBUDDY_MODELS.length,
		hints: [
			...status.state === "signed-in" ? [] : ["Connect from the plugin card, or run: dsh plugin --profile web exec dsh-workbuddy login"],
			...desktopPresent ? [] : ["Desktop auth file is optional; browser OAuth writes the plugin-owned copy instead."],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`DSH WorkBuddy ${WORKBUDDY_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} (${report.desktopAuthFile.path})`,
		`Product config: ${report.productConfig.source} (${report.productConfig.path})`,
		`Free models: ${report.productConfig.freeModels.join(", ") || "(none)"}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" ? 0 : 1;
}
async function login() {
	const client = new WorkBuddyUpstreamClient();
	const store = new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
	const oauth = new WorkBuddyOAuthLogin(client);
	const started = await oauth.start();
	process.stdout.write(`Open this URL to sign in:\n${started.authUrl}\n`);
	for (;;) {
		await new Promise((resolve) => {
			setTimeout(resolve, 2e3);
		});
		const result = await oauth.poll();
		if ("pending" in result) continue;
		const saved = await store.importCredential(result.auth);
		const who = saved.nickname ?? (saved.uid === "" ? "account" : saved.uid);
		process.stdout.write(`DSH WorkBuddy: signed in as ${who} (${workBuddyOwnAuthPath()})\n`);
		return 0;
	}
	return 1;
}
async function status(jsonOutput) {
	const store = makeStore();
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") {
		if (jsonOutput) printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy",
			version: WORKBUDDY_VERSION,
			status: "signed-out",
			hostBundle: hostState
		});
		else process.stdout.write(`DSH WorkBuddy: signed out\nHost bundle: ${hostState}\n`);
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) credits = { total: (await client.fetchCredits(credential)).total };
	} catch (error) {
		credits = {
			total: 0,
			error: safeMessage(error)
		};
	}
	const expiresAt = authStatus.expiresAtMs !== void 0 ? new Date(authStatus.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy",
			version: WORKBUDDY_VERSION,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState
		});
		return 0;
	}
	process.stdout.write([
		`DSH WorkBuddy: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error === void 0 ? `Remaining credit: ${credits?.total ?? "unknown"}` : `Remaining credit: unavailable (${credits.error})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"login",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy: expected doctor, login, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	if (flags.filter((flag) => flag !== "--json").length > 0 || jsonOutput && (action === "logout" || action === "login")) {
		process.stderr.write(`dsh-workbuddy: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput);
			case "status": return await status(jsonOutput);
			case "login": return await login();
			case "logout":
				await makeStore().logout();
				process.stdout.write(`DSH WorkBuddy: removed ${workBuddyOwnAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
