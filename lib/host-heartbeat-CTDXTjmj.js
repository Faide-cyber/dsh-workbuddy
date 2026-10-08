import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
//#region src/auth.ts
/**
* WorkBuddy (international) credential resolution.
*
* Credentials come from either:
* 1. Browser OAuth (official CLI login), saved as a plugin-owned copy under
*    `$DSH_HOME` — this is the path that does not need the desktop app.
* 2. The WorkBuddy **international** desktop app's own auth file, read-only;
*    the same plugin-owned copy also holds token refreshes so the desktop file
*    is never written.
* The effective credential is whichever of the two expires later, so a refresh
* by either side wins.
*
* International vs domestic: the two deployments write different auth files in
* the same directory — `workbuddy-desktop-ai.info` (domain `www.workbuddy.ai`,
* the overseas product) and `workbuddy-desktop.info` (domain `www.workbuddy.cn`,
* the domestic one). This plugin reads the `.ai` file, because the overseas
* deployment is the one it serves. The credential's own `domain` field is what
* actually selects the upstream host, so a mis-pointed file degrades into a
* region mismatch rather than silent cross-region traffic.
*
* @module dsh-workbuddy/auth
*/
/** Basename of the plugin-owned credential copy inside the Harness home. */
const WORKBUDDY_AUTH_FILENAME = ".workbuddy-ai-auth.json";
/** Region-scoped plugin copy for domestic credentials. */
const WORKBUDDY_CN_AUTH_FILENAME = ".workbuddy-cn-auth.json";
/** Sidecar holding additional account identities; the legacy primary stays compatible. */
const WORKBUDDY_ACCOUNTS_SUFFIX = ".accounts.json";
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Domestic desktop path override. */
const WORKBUDDY_CN_AUTH_FILE_ENV = "WORKBUDDY_CN_AUTH_FILE";
/** Domestic desktop auth basename. */
const WORKBUDDY_CN_DESKTOP_AUTH_BASENAME = "workbuddy-desktop.info";
/**
* Basename of the WorkBuddy **international** desktop auth document.
*
* The domestic build writes `workbuddy-desktop.info` in the same directory;
* only the `.ai` suffix names the overseas sign-in this plugin is built for.
*/
const WORKBUDDY_DESKTOP_AUTH_BASENAME = "workbuddy-desktop-ai.info";
/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Plugin-owned copy path inside the Harness home. */
function workBuddyOwnAuthPath() {
	return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME);
}
/** Plugin-owned primary path for a region; global keeps the legacy filename. */
function workBuddyRegionOwnAuthPath(region) {
	return join(resolveDshHome(), region === "global" ? WORKBUDDY_AUTH_FILENAME : WORKBUDDY_CN_AUTH_FILENAME);
}
const DESKTOP_AUTH_DIRECTORY = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth"
];
const ACCOUNT_NOTE_MAX = 80;
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDY_DESKTOP_AUTH_BASENAME), join(roamingAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDY_DESKTOP_AUTH_BASENAME)];
}
/**
* Platform-default candidates for the WorkBuddy **international** desktop
* app's auth file, in probe order. Windows probes both AppData roots: current
* builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
* (Roaming). WSL probes those same Windows locations through its mounted
* Windows profile before the native Linux location.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	const name = WORKBUDDY_DESKTOP_AUTH_BASENAME;
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...DESKTOP_AUTH_DIRECTORY, name)];
	if (process.platform === "win32") return [join(home, "AppData", "Local", ...DESKTOP_AUTH_DIRECTORY, name), join(home, "AppData", "Roaming", ...DESKTOP_AUTH_DIRECTORY, name)];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...DESKTOP_AUTH_DIRECTORY, name);
		return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux];
	}
	return [];
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath() {
	return defaultDesktopAuthCandidates()[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function normalizeAccountNote(value) {
	if (typeof value !== "string") return void 0;
	const note = value.trim().replace(/\s+/gu, " ");
	return note === "" ? void 0 : note.slice(0, ACCOUNT_NOTE_MAX);
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	};
}
/** Decode a JWT payload without verifying the signature (identity claims only). */
function jwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2 || parts[1] === void 0 || parts[1] === "") return void 0;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
/**
* Turn the official CLI `/v2/plugin/auth/token` payload into a credential.
* Identity fields come from the access-token JWT; the desktop file is not used.
*/
function credentialFromPluginToken(data, region = "global") {
	const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
	if (accessToken === "") throw new Error("workbuddy-ai plugin token missing accessToken");
	const payload = jwtPayload(accessToken) ?? {};
	const expiresIn = typeof data["expiresIn"] === "number" ? data["expiresIn"] : 0;
	const expiresAtFromJwt = typeof payload["exp"] === "number" && payload["exp"] > 0 ? payload["exp"] * 1e3 : 0;
	const uid = optionalString(payload["userId"]) ?? optionalString(payload["uid"]) ?? optionalString(payload["sub"]) ?? "";
	const enterpriseId = optionalString(payload["enterpriseId"]) ?? optionalString(data["enterpriseId"]);
	const nickname = optionalString(payload["nickname"]) ?? optionalString(payload["name"]) ?? optionalString(data["nickname"]);
	return {
		accessToken,
		refreshToken: typeof data["refreshToken"] === "string" ? data["refreshToken"] : "",
		expiresAtMs: expiresAtFromJwt > 0 ? expiresAtFromJwt : expiresIn > 0 ? Date.now() + expiresIn * 1e3 : 0,
		domain: optionalString(data["domain"]) ?? (region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn"),
		uid,
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Serialize the plugin-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/**
* Parse the plugin-owned copy; other versions and shapes are rejected.
*
* The owned copy stores the normalized credential itself (camelCase
* `expiresAtMs`, identity fields at the top level), not the desktop document
* shape, so it is read field by field rather than through
* {@link parseWorkBuddyAuth} — round-tripping would read `expiresAt` and an
* `account` object, find neither, zero the expiry, and drop the identity
* headers.
*/
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const enterpriseId = optionalString(stored["enterpriseId"]);
	const nickname = optionalString(stored["nickname"]);
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(stored["domain"]) ?? "",
		uid: optionalString(stored["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin (or
* already expired), keep the refreshed credential in the plugin-owned copy,
* and never write the desktop app's file. A failed refresh still returns a
* not-yet-expired token, so an unreachable refresh endpoint does not take down
* a working session.
*/
var WorkBuddyCredentialStore = class {
	refresh;
	refreshMarginMs;
	ownPath;
	desktopPathOverride;
	inflight;
	constructor(options) {
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? workBuddyOwnAuthPath();
		this.desktopPathOverride = options.desktopPath;
	}
	/**
	* Configuration precedence for the desktop file: the plugin's configured
	* path, then the environment variable, then the platform defaults. An
	* explicit path is used verbatim; the defaults are a probe order.
	*/
	resolveDesktopCandidates() {
		const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultDesktopAuthCandidates();
	}
	resolveDesktopPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/** Repoint the desktop file; a settings change applies on the next read. */
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopPath();
	}
	/** The plugin-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			throw new Error(`workbuddy-ai: no signed-in WorkBuddy (international) account found; connect from the plugin card, run \`dsh-workbuddy login\`, or sign in once in the WorkBuddy international desktop app (expected ${desktop} or ${WORKBUDDY_AUTH_FILE_ENV})`);
		}
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/** Remove the plugin-owned copy; the desktop file is untouched. */
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	/** Persist a browser-OAuth credential into the plugin-owned copy. */
	async importCredential(credential) {
		const next = {
			...credential,
			source: "dsh",
			domain: credential.domain === "" ? "www.workbuddy.ai" : credential.domain
		};
		await this.saveOwn(next);
		return next;
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy-ai: access token expired and no refresh token is stored; connect again from the plugin card or sign in in the WorkBuddy international desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy-ai: token refresh failed and the access token is expired (${String(error)}); connect again from the plugin card or open the WorkBuddy international desktop app`);
		}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Read the first desktop candidate that exists. Only an absent file (ENOENT)
	* falls through to the next candidate; a file that is present but unparsable
	* is authoritative for its slot, so a stale older-version file never silently
	* wins over a broken newer one.
	*/
	async readDesktop() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			return parseWorkBuddyAuth(await readFile(desktopPath, "utf8"));
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			if ((await stat(desktopPath)).isFile()) return true;
		} catch {}
		return false;
	}
};
/** Stable, token-free identity. A token is only hashed and never persisted in this id. */
function defaultRegionDomain(region) {
	return region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn";
}
function normalizeRegionCredential(region, credential) {
	return {
		...credential,
		domain: defaultRegionDomain(region)
	};
}
function accountIdFor(region, credential) {
	const identity = credential.uid.trim() !== "" ? credential.uid.trim() : `${credential.domain}:${credential.accessToken}`;
	return `${region}-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}
function parseStoredCredential(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const stored = value;
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const source = stored["source"] === "desktop" ? "desktop" : "dsh";
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...typeof stored["refreshExpiresAtMs"] === "number" ? { refreshExpiresAtMs: stored["refreshExpiresAtMs"] } : {},
		domain: typeof stored["domain"] === "string" ? stored["domain"] : "",
		uid: typeof stored["uid"] === "string" ? stored["uid"] : "",
		...typeof stored["enterpriseId"] === "string" ? { enterpriseId: stored["enterpriseId"] } : {},
		...typeof stored["nickname"] === "string" ? { nickname: stored["nickname"] } : {},
		source
	};
}
/**
* Region-aware, multi-account store. The legacy primary file remains in its
* version-1 shape for CLI/backward compatibility; additional accounts live in a
* token-bearing sidecar owned by this plugin only.
*/
var WorkBuddyAccountStore = class {
	accountRefresh;
	accountRefreshMarginMs;
	region;
	accountOwnPath;
	accountsPath;
	desktopPathOverride;
	selectedAccountId;
	records;
	inflight = /* @__PURE__ */ new Map();
	creditSnapshots = /* @__PURE__ */ new Map();
	creditInflight = /* @__PURE__ */ new Map();
	constructor(options) {
		this.accountRefresh = options.refresh;
		this.accountRefreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.region = options.region ?? "global";
		this.accountOwnPath = options.ownPath ?? workBuddyRegionOwnAuthPath(this.region);
		this.accountsPath = `${this.accountOwnPath}${WORKBUDDY_ACCOUNTS_SUFFIX}`;
		this.desktopPathOverride = options.desktopPath;
	}
	accountRegion() {
		return this.region;
	}
	desktopBasename() {
		return this.region === "global" ? WORKBUDDY_DESKTOP_AUTH_BASENAME : WORKBUDDY_CN_DESKTOP_AUTH_BASENAME;
	}
	desktopEnv() {
		return this.region === "global" ? WORKBUDDY_AUTH_FILE_ENV : WORKBUDDY_CN_AUTH_FILE_ENV;
	}
	desktopCandidates() {
		const fromEnv = process.env[this.desktopEnv()];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		if (this.region === "global") return defaultDesktopAuthCandidates();
		const basenameToReplace = WORKBUDDY_DESKTOP_AUTH_BASENAME;
		return defaultDesktopAuthCandidates().map((path) => path.endsWith(basenameToReplace) ? `${path.slice(0, -25)}${this.desktopBasename()}` : path);
	}
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	desktopAuthPath() {
		return this.desktopCandidates()[0];
	}
	ownAuthPath() {
		return this.accountOwnPath;
	}
	accountsAuthPath() {
		return this.accountsPath;
	}
	async readAccounts() {
		if (this.records !== void 0) return this.records;
		const records = /* @__PURE__ */ new Map();
		try {
			const parsed = JSON.parse(await readFile(this.accountsPath, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const doc = parsed;
				if (doc["version"] === 1 && Array.isArray(doc["accounts"])) {
					for (const raw of doc["accounts"]) {
						if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
						const wrapped = raw;
						const parsedCredential = parseStoredCredential(wrapped["credential"]);
						if (parsedCredential === void 0) continue;
						const credential = normalizeRegionCredential(this.region, parsedCredential);
						const id = typeof wrapped["id"] === "string" && wrapped["id"] !== "" ? wrapped["id"] : accountIdFor(this.region, credential);
						const note = normalizeAccountNote(wrapped["note"]);
						records.set(id, {
							id,
							credential,
							...note === void 0 ? {} : { note },
							checkinEnabled: wrapped["checkinEnabled"] === true
						});
					}
					if (typeof doc["selectedAccountId"] === "string") this.selectedAccountId = doc["selectedAccountId"];
				}
			}
		} catch {}
		const primary = await this.readPrimary();
		if (primary !== void 0) {
			const id = accountIdFor(this.region, primary);
			records.set(id, records.get(id) ?? {
				id,
				credential: primary,
				checkinEnabled: false
			});
			if (this.selectedAccountId === void 0) this.selectedAccountId = id;
		}
		const desktop = await this.readDesktopCredential();
		if (desktop !== void 0) {
			const id = accountIdFor(this.region, desktop);
			records.set(id, records.get(id) ?? {
				id,
				credential: desktop,
				checkinEnabled: false
			});
			if (this.selectedAccountId === void 0) this.selectedAccountId = id;
		}
		this.records = [...records.values()];
		return this.records;
	}
	async readPrimary() {
		try {
			const parsed = parseStoredCredential(JSON.parse(await readFile(this.accountOwnPath, "utf8"))["credential"]);
			return parsed === void 0 ? void 0 : normalizeRegionCredential(this.region, parsed);
		} catch {
			return;
		}
	}
	async readDesktopCredential() {
		for (const path of this.desktopCandidates()) try {
			const parsed = parseWorkBuddyAuth(await readFile(path, "utf8"));
			return parsed === void 0 ? void 0 : normalizeRegionCredential(this.region, parsed);
		} catch (error) {
			if (!isENOENT(error)) continue;
		}
	}
	async persist() {
		const records = this.records ?? [];
		await withFileLock(this.accountOwnPath, async () => {
			if (records.length === 0) {
				await rm(this.accountOwnPath, { force: true });
				await rm(this.accountsPath, { force: true });
				return;
			}
			const selected = records.find((record) => record.id === this.selectedAccountId) ?? records[0];
			this.selectedAccountId = selected?.id;
			await writeFileAtomic(this.accountOwnPath, `${JSON.stringify({
				version: 1,
				credential: selected?.credential
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			const document = {
				version: 1,
				...this.selectedAccountId === void 0 ? {} : { selectedAccountId: this.selectedAccountId },
				accounts: records
			};
			await writeFileAtomic(this.accountsPath, `${JSON.stringify(document, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	needsRefresh(credential) {
		if (credential.refreshToken === "") return false;
		return credential.expiresAtMs <= 0 || Date.now() + this.accountRefreshMarginMs >= credential.expiresAtMs;
	}
	async refreshAccount(record) {
		const current = record.credential;
		if (current.refreshToken === "" && current.expiresAtMs > Date.now() + 3e4) return current;
		if (current.refreshToken === "") throw new Error("workbuddy-ai: access token expired and no refresh token is stored; connect again");
		const outcome = await this.accountRefresh(current);
		const next = {
			...current,
			accessToken: outcome.accessToken,
			...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
			expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : current.expiresAtMs,
			...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
			source: "dsh"
		};
		const normalized = normalizeRegionCredential(this.region, next);
		record.credential = normalized;
		await this.persist();
		return normalized;
	}
	async accounts() {
		return (await this.readAccounts()).map((record) => ({
			id: record.id,
			region: this.region,
			...record.credential.nickname === void 0 ? {} : { nickname: record.credential.nickname },
			...record.note === void 0 ? {} : { note: record.note },
			...record.credential.domain === "" ? {} : { domain: record.credential.domain },
			source: record.credential.source,
			expiresAtMs: record.credential.expiresAtMs,
			selected: record.id === this.selectedAccountId,
			checkinEnabled: record.checkinEnabled
		}));
	}
	async current() {
		const records = await this.readAccounts();
		return records.find((record) => record.id === this.selectedAccountId)?.credential ?? records[0]?.credential;
	}
	async credentialFor(accountId) {
		return (await this.readAccounts()).find((record) => record.id === accountId)?.credential;
	}
	selectedId() {
		return this.selectedAccountId;
	}
	async resolveFor(accountId) {
		const record = (await this.readAccounts()).find((item) => item.id === accountId);
		if (record === void 0) throw new Error("workbuddy-ai: account not found");
		if (!this.needsRefresh(record.credential)) return record.credential;
		const running = this.inflight.get(accountId);
		if (running !== void 0) return running;
		const promise = this.refreshAccount(record).finally(() => this.inflight.delete(accountId));
		this.inflight.set(accountId, promise);
		return promise;
	}
	async resolve() {
		const current = await this.current();
		if (current === void 0) throw new Error("workbuddy-ai: no signed-in account found; connect from the plugin card");
		const id = accountIdFor(this.region, current);
		return this.resolveFor(id);
	}
	async status() {
		const current = await this.current();
		if (current === void 0) return { state: "signed-out" };
		return {
			state: "signed-in",
			expiresAtMs: current.expiresAtMs,
			...current.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: current.refreshExpiresAtMs },
			...current.nickname === void 0 ? {} : { nickname: current.nickname },
			...current.domain === "" ? {} : { domain: current.domain },
			source: current.source
		};
	}
	async refreshCreditSnapshots(fetchCredits, activeIntervalMs, inactiveIntervalMs) {
		const records = await this.readAccounts();
		const now = Date.now();
		for (const record of records) {
			const previous = this.creditSnapshots.get(record.id);
			const interval = record.id === this.selectedAccountId ? activeIntervalMs : inactiveIntervalMs;
			if (previous !== void 0 && now - previous.checkedAt < interval) continue;
			const running = this.creditInflight.get(record.id);
			if (running !== void 0) {
				await running;
				continue;
			}
			const refresh = (async () => {
				try {
					const credits = await fetchCredits(await this.resolveFor(record.id));
					this.creditSnapshots.set(record.id, {
						credits,
						checkedAt: Date.now()
					});
				} catch (error) {
					this.creditSnapshots.set(record.id, {
						error: String(error).slice(0, 300),
						checkedAt: Date.now()
					});
				}
			})();
			this.creditInflight.set(record.id, refresh);
			try {
				await refresh;
			} finally {
				this.creditInflight.delete(record.id);
			}
		}
		return this.creditSnapshots;
	}
	creditSnapshot(accountId) {
		return this.creditSnapshots.get(accountId);
	}
	async select(accountId) {
		if (!(await this.readAccounts()).some((record) => record.id === accountId)) throw new Error("workbuddy-ai: account not found");
		this.selectedAccountId = accountId;
		await this.persist();
	}
	async importCredential(credential, accountId) {
		const next = normalizeRegionCredential(this.region, {
			...credential,
			source: "dsh"
		});
		const records = await this.readAccounts();
		const id = accountId ?? accountIdFor(this.region, next);
		const existing = records.find((record) => record.id === id);
		if (existing === void 0) records.push({
			id,
			credential: next,
			checkinEnabled: false
		});
		else existing.credential = next;
		this.selectedAccountId = id;
		await this.persist();
		return next;
	}
	async setCheckinEnabled(accountId, enabled) {
		const record = (await this.readAccounts()).find((item) => item.id === accountId);
		if (record === void 0) throw new Error("workbuddy-ai: account not found");
		record.checkinEnabled = enabled;
		await this.persist();
	}
	/** Store a note and return the normalized value kept, or undefined when cleared. */
	async setNote(accountId, note) {
		const record = (await this.readAccounts()).find((item) => item.id === accountId);
		if (record === void 0) throw new Error("workbuddy-ai: account not found");
		const normalized = normalizeAccountNote(note);
		if (normalized === void 0) delete record.note;
		else record.note = normalized;
		await this.persist();
		return normalized;
	}
	async removeAccount(accountId) {
		const records = await this.readAccounts();
		const kept = records.filter((record) => record.id !== accountId);
		if (kept.length === records.length) return;
		this.records = kept;
		this.selectedAccountId = kept[0]?.id;
		await this.persist();
	}
	/** Existing logout semantics: remove all plugin-owned credentials, never desktop auth. */
	async logout() {
		this.records = [];
		this.selectedAccountId = void 0;
		await rm(this.accountOwnPath, { force: true });
		await rm(this.accountsPath, { force: true });
		await rm(`${this.accountOwnPath}.lock`, { force: true });
	}
};
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* The order matters and is not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-workbuddy/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The upstream's "this effort value is not supported" code, measured
* against the live upstream. It is *not* treated as a permanent protocol promise:
* anything unrecognized degrades to `unknown` rather than to a capability
* conclusion.
*/
const INVALID_EFFORT_CODE = "invalid_reasoning_effort";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* Personal model-catalog paths per region, preferred first.
*
* The domestic `/v3/config` is the catalog the app itself reads: its `cli`
* roster carries the free `hy4-preview-f` slot at `x0.00`. The legacy
* personal-models path is the CLI-channel roster, whose second slot is the
* *paid* `hy4-preview` (`x0.29`) under the same display name "Hy4 preview" —
* real, but the wrong price list to build a picker from. Keep it as fallback.
*/
const CATALOG_PATH = {
	global: ["/v2/enterprises/personal/models"],
	cn: ["/v3/config", "/console/enterprises/personal/models"]
};
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES$1 = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES$1.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES$1.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES$1.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some rows
* report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
/**
* Read an upstream timestamp string as epoch ms.
*
* `CycleEndTime` arrives as `YYYY-MM-DD HH:mm:ss` with no zone and is Beijing
* wall time on the serving side, so parsing it with `new Date(string)` would
* silently reinterpret it in the host's own zone. The parts are read as UTC and
* shifted by a fixed +08:00 instead, which is exact for the upstream and never
* depends on where the host happens to run.
*
* @param value - raw upstream value, e.g. `"2026-10-31 23:59:59"`.
* @returns epoch ms, or undefined when the value is absent or unparseable.
*/
function parseUpstreamExpiry(value) {
	if (typeof value !== "string") return void 0;
	const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
	if (matched === null) return void 0;
	const [, year, month, day, hour, minute, second] = matched;
	return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - 288e5;
}
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/**
* Whether a credits multiplier means "free".
*
* Only an explicit `x0.00` (with or without the `x`, any number of decimals)
* counts. An absent multiplier is *not* free: the upstream omits the field for
* some rows and treating absence as free would advertise a paid model.
*/
function isFreeCredits(credits) {
	const bare = normalizeCredits(credits);
	if (bare === void 0) return false;
	return /^x?0(?:\.0+)?$/u.test(bare);
}
/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = wrapped["tags"];
	if (Array.isArray(rawTags)) for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "") badges.push(label);
	}
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free: isFreeCredits(credits)
	} };
}
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Region for a login domain.
*
* An empty domain resolves to `global`, not `cn`: this plugin is the
* international one, so an unlabelled credential is treated as belonging to the
* deployment it was configured for. A credential that names the domestic domain
* still routes domestic, because the `domain` field is the upstream's own
* routing fact and second-guessing it would send a `.cn` token to `.ai`.
*/
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "" || lowered.endsWith("workbuddy.ai") || lowered.endsWith("codebuddy.ai")) return "global";
	return "cn";
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Unauthenticated CLI-login headers; no Bearer, no refresh token. */
function pluginAuthHeaders(region = "global") {
	const origin = region === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
	return {
		"Accept": "*/*",
		"Content-Type": "application/json",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": origin,
		"Referer": `${origin}/`,
		"User-Agent": CLIENT_UA,
		"X-No-Authorization": "true",
		"X-No-User-Id": "true",
		"X-No-Enterprise-Id": "true",
		"X-No-Department-Info": "true"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream.
*
* Three rewrites, each fixing a measured rejection:
*
* 1. `stream` is forced true — the upstream refuses a non-streaming chat call.
* 2. `role: "developer"` becomes `role: "system"` — pi-ai emits the system
*    prompt with the OpenAI `developer` role, which this upstream answers with
*    HTTP 400 code 11128.
* 3. `tool_choice` is flattened to the string form the upstream expects; an
*    object form returns 400.
*
* It additionally guarantees the upstream's "first message is system prompt"
* rule: a request whose first message is not a system message is answered with
* code 11128 and never reaches a model. DSH normally supplies a system prompt,
* but a session with an empty instruction set would otherwise fail every call,
* so a minimal one is prepended rather than letting the request die.
*
* @param source - the JSON request body pi-ai produced.
* @returns the rewritten body, or the input unchanged when it is not a JSON object.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	ensureLeadingSystemMessage(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/**
* Guarantee the upstream's requirement that the first message is a system
* prompt. Only an actually-missing leading system message is repaired; a body
* with no `messages` array at all is left alone, because the upstream's own
* validation is the better error for a malformed request.
*/
function ensureLeadingSystemMessage(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages) || messages.length === 0) return;
	const first = messages[0];
	if (typeof first === "object" && first !== null && !Array.isArray(first) && first["role"] === "system") return;
	messages.unshift({
		role: "system",
		content: "You are a helpful assistant."
	});
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy-ai upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy-ai upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy-ai upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take the
* credential explicitly so token refreshes apply on the next call.
*/
var WorkBuddyUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy-ai token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/** POST the official CLI login start; returns the browser `authUrl`. */
	async startPluginLogin(nonce, region = "global") {
		const response = await fetch(`${region === "global" ? GLOBAL_BASE : CN_CHAT_BASE}/v2/plugin/auth/state?platform=CLI&nonce=${encodeURIComponent(nonce)}`, {
			method: "POST",
			headers: pluginAuthHeaders(region),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const state = typeof data["state"] === "string" ? data["state"] : "";
		const authUrl = typeof data["authUrl"] === "string" ? data["authUrl"] : "";
		if (state === "" || authUrl === "") throw new Error("workbuddy-ai login start missing state/authUrl");
		return {
			state,
			authUrl
		};
	}
	/**
	* GET the CLI login token. Envelope code `11217` means the browser has not
	* finished yet — returns `undefined` so the caller can poll again.
	*/
	async pollPluginToken(state, region = "global") {
		const response = await fetch(`${region === "global" ? GLOBAL_BASE : CN_CHAT_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
			headers: pluginAuthHeaders(region),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (envelope.code === 11217) return void 0;
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		if (typeof envelope.data !== "object" || envelope.data === null) throw new Error("workbuddy-ai login token returned no data");
		return envelope.data;
	}
	/**
	* GET the personal model catalog from the region's own path and keep the
	* `cli` agent's models only.
	*
	* The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
	* the overseas host answers the domestic path with HTTP 500, so this is what
	* makes an international sign-in work at all.
	*/
	async fetchModels(credential) {
		const paths = CATALOG_PATH[regionOf(credential.domain)];
		let failure;
		for (const path of paths) try {
			return await this.readCatalog(credential, path);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}
		throw failure ?? /* @__PURE__ */ new Error("workbuddy-ai model catalog has no path to read");
	}
	/** GET one catalog path and keep the `cli` agent's models only. */
	async readCatalog(credential, path) {
		const response = await fetch(`${chatBase(credential)}${path}`, {
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json",
				"Origin": originReferer(credential),
				"Referer": `${originReferer(credential)}/`,
				"User-Agent": CLIENT_UA
			},
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy-ai model catalog lists no cli agent models");
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			if (typeof model !== "object" || model === null) continue;
			const wrapped = model;
			const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
			if (id === "" || wrapped["disabled"] === true) continue;
			const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
			const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
			if (input <= 0 || output <= 0) continue;
			byId.set(id, {
				id,
				name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
				contextWindow: input,
				maxTokens: output,
				supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
				...resolveUpstreamReasoning(wrapped),
				...resolveUpstreamBilling(wrapped)
			});
		}
		const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddy-ai model catalog resolved to an empty list");
		return models;
	}
	/** POST the billing endpoint for the aggregated remaining credit. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const monthly = numberField("CapacityType") === 4;
			const size = monthly ? numberField("CycleCapacitySize") : numberField("CapacitySize");
			const remain = Math.max(0, monthly ? numberField("CycleCapacityRemain") : numberField("CapacityRemain"));
			total += remain;
			const expiresAt = parseUpstreamExpiry(account["CycleEndTime"]);
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size,
				capacityType: numberField("CapacityType"),
				...expiresAt === void 0 ? {} : { expiresAt }
			});
		}
		return {
			total,
			accounts
		};
	}
	/** A catalog request is a low-cost connectivity check; it never sends a chat completion. */
	async testConnectivity(credential) {
		await this.fetchModels(credential);
	}
	/** Read the domestic daily-check-in state. International accounts do not support this API. */
	async fetchCheckinStatus(credential) {
		if (regionOf(credential.domain) !== "cn") throw new Error("workbuddy-ai: daily check-in is only available for domestic accounts");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const nested = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : data;
		const boolField = (...keys) => keys.some((key) => nested[key] === true);
		const numberField = (...keys) => {
			for (const key of keys) if (typeof nested[key] === "number") return nested[key];
		};
		const streakDays = numberField("streak_days", "streakDays");
		const dailyCredit = numberField("daily_credit", "dailyCredit");
		const todayCredit = numberField("today_credit", "todayCredit");
		return {
			active: boolField("active", "Active"),
			todayCheckedIn: boolField("today_checked_in", "todayCheckedIn", "TodayCheckedIn"),
			...streakDays === void 0 ? {} : { streakDays },
			...dailyCredit === void 0 ? {} : { dailyCredit },
			...todayCredit === void 0 ? {} : { todayCredit }
		};
	}
	/** Claim the domestic daily check-in reward after status says it is needed. */
	async claimDailyCheckin(credential) {
		if (regionOf(credential.domain) !== "cn") throw new Error("workbuddy-ai: daily check-in is only available for domestic accounts");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* One probe request: a real streaming chat call carrying the effort under
	* test.
	*
	* Shares {@link chatHeaders} with the normal chat path on purpose — a probe
	* must describe what a real message would experience, not a parallel code
	* path. The caller aborts as soon as a parseable event arrives; the body is
	* never assembled into an answer. `reasoning_effort` is omitted entirely
	* (rather than sent empty) when `effort` is undefined, so the baseline case is
	* a genuinely bare request.
	*/
	async probeEffort(credential, model, effort, signal) {
		const payload = {
			model,
			stream: true,
			messages: [{
				role: "system",
				content: PROBE_PROMPT
			}, {
				role: "user",
				content: PROBE_PROMPT
			}],
			max_tokens: 1
		};
		if (effort !== void 0) payload["reasoning_effort"] = effort;
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			return {
				status: response.status,
				streamed: false,
				...errorCodeOf(text)
			};
		}
		const streamed = await readFirstEvent(response);
		return {
			status: response.status,
			streamed
		};
	}
};
/**
* Growth-plan ("小猫成长计划" / 派猫猫旅行) headers.
*
* These live under `/activity/growth/...`, **not** `/v2/...` — prefixing them
* with `/v2/` makes the gateway answer 401 `Authorization Required`, because
* that path is registered against a different auth plugin. This API also does
* not read `X-User-Id`/`X-Domain`; it identifies the account from the Bearer
* alone. It does check `Referer` against the growth center, so the header is
* load-bearing rather than cosmetic.
*/
function growthHeaders(credential) {
	const base = originReferer(credential);
	return {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json, text/plain, */*",
		"Content-Type": "application/json",
		"X-Codebuddy-Request": "1",
		"X-Client-Platform": "web",
		"Origin": base,
		"Referer": `${base}/profile/growth-center`
	};
}
const GROWTH_PREFIX = "/activity/growth/buddy/travel";
async function growthRequest(credential, path, method, body) {
	const response = await fetch(`${originReferer(credential)}${GROWTH_PREFIX}${path}`, {
		method,
		headers: growthHeaders(credential),
		...body === void 0 ? {} : { body: JSON.stringify(body) },
		signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
	});
	const envelope = await readEnvelope(response);
	if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	return typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data) ? envelope.data : {};
}
/**
* Read the growth-plan state.
*
* Deliberately read-only: a `GET` here is what the card polls, and it must
* never be the call that dispatches a trip.
*/
async function fetchGrowthStatus(credential) {
	const data = await growthRequest(credential, "/status", "GET");
	const number = (...keys) => {
		for (const key of keys) {
			const value = data[key];
			if (typeof value === "number") return value;
		}
	};
	const location = typeof data["location"] === "object" && data["location"] !== null ? data["location"] : void 0;
	const recordId = number("record_id", "recordId");
	const rewardCredit = number("reward_credit", "rewardCredit");
	const arriveAt = number("arrive_at", "arriveAt");
	return {
		state: typeof data["state"] === "string" ? data["state"] : "",
		dailyLimitReached: data["daily_limit_reached"] === true,
		...recordId === void 0 || recordId === 0 ? {} : { recordId },
		...rewardCredit === void 0 || rewardCredit === 0 ? {} : { rewardCredit },
		...arriveAt === void 0 || arriveAt === 0 ? {} : { arriveAt: arriveAt * 1e3 },
		...typeof location?.["name"] === "string" ? { locationName: location["name"] } : {}
	};
}
/**
* The destination a trip can be sent to, as `/config` lists it.
*
* `depart` rejects an empty body with HTTP 400 `invalid request` — the upstream
* does not pick a destination for you — so a caller with no preference still has
* to name one. `/config` is the only place those ids are published.
*/
async function fetchGrowthLocations(credential) {
	const data = await growthRequest(credential, "/config", "GET");
	const locations = Array.isArray(data["locations"]) ? data["locations"] : [];
	const ids = [];
	for (const location of locations) {
		if (typeof location !== "object" || location === null) continue;
		const id = location["id"];
		if (typeof id === "number" && id !== 0) ids.push(id);
	}
	return ids;
}
/**
* What today's trip paid, read from the trip log.
*
* `/status` cannot answer this: once the buddy is idle it reports
* `reward_credit: 0` whether or not a payout happened, so the card could only
* ever say "今日旅行已完成" and hide the credits. `/records` is the log of
* finished trips and keeps the real amount per day.
*
* Returns `undefined` when there is no finished trip today, so the caller can
* tell "not yet" apart from "paid zero".
*/
async function fetchGrowthRewardToday(credential, day) {
	const data = await growthRequest(credential, "/records", "GET");
	const records = Array.isArray(data["records"]) ? data["records"] : [];
	for (const entry of records) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		if (record["travel_date"] !== day) continue;
		if (typeof record["claimed_at"] !== "number" || record["claimed_at"] === 0) continue;
		const reward = record["reward_credit"];
		if (typeof reward === "number") return reward;
	}
}
/**
* Send the buddy on a trip, then claim whatever is already claimable.
*
* One call, because the two halves belong together: a card that dispatches at
* dusk and claims at dawn is a card the user has to come back for. `claim` is
* idempotent upstream (it reports "nothing to claim" rather than erroring), so
* calling it first is safe and is what lets a trip that arrived while DSH was
* closed get its credit on the next poll.
*
* `locationId` of 0 means "no preference": the first destination from `/config`
* is used. It cannot mean "send no location" — the upstream answers that with
* HTTP 400, which is what made this a silent no-op on the card.
*/
async function runGrowthTrip(credential, locationId = 0) {
	const before = await fetchGrowthStatus(credential);
	if (before.state === "arrived") return {
		dispatched: false,
		...await claimGrowth(credential, before.recordId)
	};
	if (before.dailyLimitReached) return {
		dispatched: false,
		reason: "daily-limit"
	};
	if (before.state === "traveling") return {
		dispatched: false,
		reason: "traveling"
	};
	if (before.state !== "idle") return {
		dispatched: false,
		reason: "unknown-state"
	};
	let target = locationId;
	if (target === 0) {
		const [first] = await fetchGrowthLocations(credential);
		if (first === void 0) return {
			dispatched: false,
			reason: "no-destination"
		};
		target = first;
	}
	try {
		await growthRequest(credential, "/depart", "POST", { location_id: target });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already[\s_-]?traveling/i.test(message) || /already[\s_-]?dispatched/i.test(message)) return {
			dispatched: false,
			reason: "traveling"
		};
		if (/daily[\s_-]?limit/i.test(message)) return {
			dispatched: false,
			reason: "daily-limit"
		};
		throw error;
	}
	return { dispatched: true };
}
/** Collect a finished trip's credit. A missing reward reports 0, not an error. */
async function claimGrowth(credential, recordId) {
	try {
		const reward = (await growthRequest(credential, "/claim", "POST", recordId === void 0 ? {} : { record_id: recordId }))["reward_credit"];
		return typeof reward === "number" && reward > 0 ? { claimed: reward } : { reason: "nothing-to-claim" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/no unclaimed|not arrived|already[\s_-]?claim/i.test(message)) return { reason: "nothing-to-claim" };
		throw error;
	}
}
/**
* Growth-center tasks, activity reports and task claims.
*
* These live under `/v2/activity/growth/tasks`, not under the travel prefix, and
* they are **soft** calls: a claim for a task that is not finished answers HTTP
* 400 with `错误的请求`, and an already-claimed task answers a non-zero business
* code. Both are ordinary states of a task that has already moved on, so they
* are returned as results rather than thrown — turning them into exceptions is
* how a whole run dies on the last, already-handled task.
*
* `/v2/report` is what actually lights the counters: the upstream derives task
* progress from the events the official client reports, not from watching the
* user. See `growth-tasks.ts` for the event shapes.
*/
/** The tasks prefix for the growth center. */
const GROWTH_TASKS_PREFIX = "/v2/activity/growth/tasks";
async function growthSoftRequest(credential, url, method, body) {
	const response = await fetch(url, {
		method,
		headers: growthHeaders(credential),
		...body === void 0 ? {} : { body: JSON.stringify(body) },
		signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
	});
	const envelope = await readEnvelope(response);
	const data = typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data) ? envelope.data : {};
	return {
		ok: response.ok && envelope.code === 0,
		code: envelope.code,
		msg: envelope.msg,
		data
	};
}
const growthUrl = (credential, path) => `${originReferer(credential)}${path}`;
/**
* Every task the growth center currently lists.
*
* An empty list is returned as-is rather than thrown: the caller has to treat
* "no tasks" as a failed run (it means the read did not work or the account has
* nothing enrolled), and it can only do that if it sees the emptiness.
*/
async function fetchGrowthTasks(credential) {
	const result = await growthSoftRequest(credential, growthUrl(credential, `${GROWTH_TASKS_PREFIX}`), "GET");
	if (!result.ok) throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`);
	const raw = Array.isArray(result.data["tasks"]) ? result.data["tasks"] : [];
	const tasks = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const task = entry;
		const code = task["task_code"];
		if (typeof code !== "string" || code === "") continue;
		const progress = typeof task["progress"] === "object" && task["progress"] !== null ? task["progress"] : {};
		const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
		tasks.push({
			code,
			title: typeof task["title"] === "string" ? task["title"] : code,
			status: typeof task["accept_status"] === "string" ? task["accept_status"] : "",
			current: num(progress["current"]),
			target: num(progress["target"]),
			rewardCredit: num(task["reward_credit"])
		});
	}
	return tasks;
}
/**
* Accept tasks that are still `not_accepted`.
*
* An empty list is not sent: the upstream answers an empty `task_codes` with a
* different (and useless) shape, and there is nothing to accept anyway.
*/
async function acceptGrowthTasks(credential, codes) {
	if (codes.length === 0) return;
	const result = await growthSoftRequest(credential, growthUrl(credential, `${GROWTH_TASKS_PREFIX}/accept`), "POST", { task_codes: [...codes] });
	if (!result.ok) throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`);
}
/**
* Post activity events, which is what moves task progress.
*
* The body must be an **array** even for a single event; an object is accepted
* by the transport and then counted nowhere.
*/
async function reportGrowthEvents(credential, events) {
	if (events.length === 0) return;
	const result = await growthSoftRequest(credential, growthUrl(credential, "/v2/report"), "POST", [...events]);
	if (!result.ok) throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`);
}
/**
* Claim a finished task's credit.
*
* `ok: false` covers "not finished yet" (HTTP 400) and "already claimed" — both
* mean the credit is not coming this round, which the caller records as pending
* rather than failing the whole run.
*/
async function claimGrowthTask(credential, code) {
	const result = await growthSoftRequest(credential, growthUrl(credential, `/activity/growth/tasks/${encodeURIComponent(code)}/claim`), "POST", {});
	if (!result.ok) return {
		ok: false,
		reason: result.msg === "" ? `http ${result.code}` : result.msg
	};
	const credit = result.data["credit"];
	return typeof credit === "number" && credit > 0 ? {
		ok: true,
		credit
	} : { ok: true };
}
/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const extError = parsed["extError"];
			if (typeof extError === "object" && extError !== null && !Array.isArray(extError)) {
				const code = extError["code"];
				if (typeof code === "string") return {
					errorCode: code,
					detail: code
				};
			}
		}
	} catch {}
	return { detail: text.slice(0, 200) };
}
/**
* Consume just enough of a streaming response to know it really streams.
*
* Returns true on the first chunk containing a data line. Cancels the body
* afterwards; a stream that ends or errors before that counts as not streamed,
* because an empty 200 is not evidence the effort was accepted.
*/
async function readFirstEvent(response) {
	const body = response.body;
	if (body === null) return false;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (decoder.decode(value, { stream: true }).includes("data:")) return true;
		}
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
//#endregion
//#region src/product-config.ts
/**
* WorkBuddy product configuration: the authority on what a model costs, and
* the source of metadata for the models the catalog endpoint omits.
*
* Why this module exists at all — two measured defects in the catalog endpoint
* (`/v2/enterprises/personal/models`) that a naive plugin would inherit:
*
* 1. **It is not the price authority.** The catalog reports `hy4-preview` at
*    `x0.00` (free) while the app's own product configuration prices it
*    `x0.29`. Trusting the catalog would advertise a paid model as free and
*    spend the user's credit without warning.
* 2. **It omits genuinely free models.** `deepseek-v4.1-flash` and
*    `hy4-preview-f` are absent from the catalog entirely, yet both are
*    `x0.00` in the product configuration. Without this module the plugin could
*    not offer the one model this whole exercise is about.
*
* Where the data comes from: the WorkBuddy desktop app caches the configuration
* it is served at `~/.workbuddy-ai/cache/acc-product-config-v3.json` (the
* directory name comes from the config's own `dataFolderName` field, and its
* `applicationName` is `workbuddy-ai` — the international build). That file is
* read-only input here; this plugin never writes to the app's directory.
*
* When the cache is missing (fresh install, another machine, an app update that
* renames it) the built-in {@link FALLBACK_FREE_MODELS} table serves instead, so
* the free list never degrades to "nothing is free" or, worse, "everything is".
*
* @module dsh-workbuddy/product-config
*/
/** Directory the international WorkBuddy app keeps its state in. */
const WORKBUDDY_DATA_FOLDER = ".workbuddy-ai";
/** Cached product-configuration basename inside that directory. */
const WORKBUDDY_PRODUCT_CONFIG_BASENAME = "acc-product-config-v3.json";
/** Env variable overriding the product-config file location. */
const WORKBUDDY_PRODUCT_CONFIG_ENV = "WORKBUDDY_PRODUCT_CONFIG";
/** Absolute path of the cached product configuration. */
function workBuddyProductConfigPath() {
	const override = process.env[WORKBUDDY_PRODUCT_CONFIG_ENV];
	if (override !== void 0 && override.trim() !== "") return override.trim();
	return join(homedir(), WORKBUDDY_DATA_FOLDER, "cache", WORKBUDDY_PRODUCT_CONFIG_BASENAME);
}
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Every model the international deployment prices `x0.00`, with the metadata
* copied verbatim from the product configuration.
*
* This is the fallback the plugin uses when the app's cache cannot be read, and
* it is deliberately a *whitelist of the free* rather than a blacklist of the
* paid: a model absent from both this table and the cache is treated as paid, so
* the failure mode is "a free model is missing" rather than "a paid model is
* billed silently".
*
* `hy4-preview` (without the `-f`) is deliberately absent even though the
* catalog endpoint reports it as `x0.00`: the product configuration prices it
* `x0.29`, so it is paid, and it shares its display name with `hy4-preview-f` —
* including both would show two identically-named rows, one of them billable.
*/
const BUILTIN_FREE_MODELS = [
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	},
	{
		id: "hy4-preview-f",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	}
];
/** Ids of the models the product configuration prices free. */
const FALLBACK_FREE_MODEL_IDS = BUILTIN_FREE_MODELS.map((model) => model.id);
/**
* Last-known international `credits` multipliers, used when the app cache is
* absent. Catalog `x0.00` is not trusted (`hy4-preview` is x0.29 here).
*/
const BUILTIN_CREDITS = {
	"deepseek-v4.1-flash": "x0.00",
	"hy4-preview-f": "x0.00",
	"hy3": "x0.00",
	"hy4-preview": "x0.29",
	"fast-model": "x0.34",
	"balanced-model": "x0.59",
	"primary-model": "x3.31",
	"deep-model": "x3.33",
	"gpt-6-astra": "x6.67",
	"gpt-5.6-sol": "x3.47",
	"gpt-5.6-terra": "x1.39",
	"gpt-5.6-luna": "x0.14",
	"gpt-5.5": "x3.31",
	"gpt-5.4": "x1.65",
	"gpt-5.3-codex": "x1.25",
	"gemini-3.5-flash": "x0.99",
	"glm-5.3": "x0.79",
	"glm-5.2": "x0.79",
	"kimi-k3": "x1.62",
	"kimi-k2.6": "x0.52"
};
/**
* The subset the catalog endpoint does not return, so they must be injected.
*
* `hy3` is absent from this list because the endpoint does list it; the other
* two are missing from the live catalog entirely.
*/
const FALLBACK_EXTRA_MODELS = BUILTIN_FREE_MODELS.filter((model) => model.id !== "hy3");
/** Effort set the international deployment accepts for a model it declares none for. */
const IMPLIED_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Narrow one `models[]` row; returns undefined for a row with no usable id. */
function parseProductModel(value) {
	const row = asRecord(value);
	if (row === void 0) return void 0;
	const id = typeof row["id"] === "string" ? row["id"].trim() : "";
	if (id === "") return void 0;
	const reasoning = asRecord(row["reasoning"]);
	const rawEfforts = reasoning?.["supportedEfforts"];
	let supportedEfforts;
	if (Array.isArray(rawEfforts)) {
		const efforts = rawEfforts.filter((effort) => typeof effort === "string" && EFFORT_VALUES.includes(effort));
		if (efforts.length > 0) supportedEfforts = efforts;
	}
	const rawDefault = reasoning?.["defaultEffort"] ?? reasoning?.["effort"];
	const defaultEffort = typeof rawDefault === "string" && EFFORT_VALUES.includes(rawDefault) ? rawDefault : void 0;
	const contextWindow = positiveNumber(row["maxInputTokens"]) ?? positiveNumber(row["maxAllowedSize"]) ?? 0;
	const maxTokens = positiveNumber(row["maxOutputTokens"]) ?? 0;
	return {
		id,
		name: typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : id,
		...typeof row["credits"] === "string" && row["credits"].trim() !== "" ? { credits: row["credits"].trim() } : {},
		contextWindow,
		maxTokens,
		supportsImages: row["supportsImages"] === true && row["disabledMultimodal"] !== true,
		supportsReasoning: row["supportsReasoning"] === true,
		onlyReasoning: row["onlyReasoning"] === true,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking: reasoning?.["canDisableThinking"] === true
	};
}
/** Parse a product-configuration document; undefined when it is not usable. */
function parseProductConfig(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	const document = asRecord(parsed);
	if (document === void 0) return void 0;
	const rawModels = document["models"];
	if (!Array.isArray(rawModels)) return void 0;
	const models = rawModels.map(parseProductModel).filter((model) => model !== void 0);
	if (models.length === 0) return void 0;
	return {
		source: "cache",
		...typeof document["applicationName"] === "string" ? { applicationName: document["applicationName"] } : {},
		...typeof document["endpoint"] === "string" ? { endpoint: document["endpoint"] } : {},
		isOversea: document["isOversea"] === true,
		models
	};
}
/** The built-in configuration: free rows with full metadata, plus paid rates. */
function builtinConfig() {
	const models = BUILTIN_FREE_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		credits: BUILTIN_CREDITS[model.id] ?? "x0.00",
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportsImages: model.supportsImages,
		supportsReasoning: model.reasoning?.supports === true,
		onlyReasoning: model.reasoning?.onlyReasoning === true,
		...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort },
		canDisableThinking: model.reasoning?.canDisableThinking === true
	}));
	const seen = new Set(models.map((model) => model.id));
	for (const [id, credits] of Object.entries(BUILTIN_CREDITS)) {
		if (seen.has(id)) continue;
		models.push({
			id,
			name: id,
			credits,
			contextWindow: 0,
			maxTokens: 0,
			supportsImages: false,
			supportsReasoning: false,
			onlyReasoning: false,
			canDisableThinking: false
		});
	}
	return {
		source: "builtin",
		models
	};
}
/**
* Load the product configuration, falling back to the built-in table.
*
* A missing or malformed cache is never an error: the plugin must still offer
* its free models on a machine where the app has not run yet.
*/
function loadProductConfig(path = workBuddyProductConfigPath()) {
	try {
		const parsed = parseProductConfig(readFileSync(path, "utf8"));
		if (parsed === void 0) return builtinConfig();
		return {
			...parsed,
			path
		};
	} catch {
		return builtinConfig();
	}
}
/** Whether a credits multiplier means free (`x0.00`). Absent is not free. */
function creditsAreFree(credits) {
	if (credits === void 0) return false;
	return /^x?0(?:\.0+)?$/u.test(credits.trim());
}
/**
* The free model ids a configuration declares.
*
* Only an explicit `x0.00` counts. When the cache is absent the built-in
* whitelist applies, so the answer is never "every model" — a mis-read must not
* be able to turn the free-only filter into a no-op.
*/
function freeModelIds(config) {
	const free = config.models.filter((model) => creditsAreFree(model.credits)).map((model) => model.id);
	return free.length > 0 ? free : FALLBACK_FREE_MODEL_IDS;
}
/** Reasoning metadata from a product-config row, in the catalog's own shape. */
function reasoningFromProduct(model) {
	const declared = model.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : IMPLIED_EFFORTS;
	return {
		supports: model.supportsReasoning,
		onlyReasoning: model.onlyReasoning,
		supportedEfforts: efforts,
		...model.defaultEffort === void 0 ? {} : { defaultEffort: model.defaultEffort },
		canDisableThinking: model.canDisableThinking
	};
}
/** Billing metadata for a model the product configuration marks free. */
function billingFromProduct(model) {
	const credits = model.credits ?? "x0.00";
	return {
		credits,
		free: creditsAreFree(credits)
	};
}
/**
* Build a catalog row from a product-configuration model.
*
* Used for models the catalog endpoint omits. A row with no usable capacities is
* refused rather than guessed: an unlisted model with a fabricated context
* window would make the harness compact at the wrong point.
*/
function productModelToCatalogRow(model) {
	if (model.contextWindow <= 0 || model.maxTokens <= 0) return void 0;
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportsImages: model.supportsImages,
		reasoning: reasoningFromProduct(model),
		billing: billingFromProduct(model)
	};
}
/** Look up one product-config row by id. */
function productModelById(config, id) {
	return config.models.find((model) => model.id === id);
}
//#endregion
//#region src/catalog.ts
/**
* Static rows served before the first upstream answer arrives, and whenever the
* upstream is unreachable.
*
* These are the two free models the international deployment does not list in
* its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
* first moment means an offline upstream never leaves the provider empty.
*/
const FALLBACK_WORKBUDDY_MODELS = BUILTIN_FREE_MODELS;
/**
* Merge the upstream catalog with the product configuration under one billing
* policy.
*
* Order of operations, each step deliberate:
*
* 1. Start from the upstream rows (or the fallback when there are none yet).
* 2. Add product-config rows for free models the upstream omitted — this is what
*    brings `deepseek-v4.1-flash` and `hy4-preview-f` into the picker.
* 3. Overwrite each row's billing with the product configuration's verdict when
*    it has one, so the catalog's wrong `x0.00` on a paid model cannot survive.
* 4. Drop everything outside the policy's allow-list, *last*, so no later step
*    can reintroduce a model the policy excluded.
*
* @param upstream - rows from the live catalog; empty before the first fetch.
* @param options - product configuration and the active billing policy.
* @returns the effective model list, upstream order first.
*/
function composeCatalog(upstream, options) {
	const { productConfig, scope = "free", priceAuthority = "product" } = options;
	const free = priceAuthority === "upstream" ? new Set(upstream.filter((model) => model.billing?.free === true).map((model) => model.id)) : new Set(freeModelIds(productConfig));
	const byId = /* @__PURE__ */ new Map();
	const source = upstream.length > 0 ? upstream : FALLBACK_WORKBUDDY_MODELS;
	for (const model of source) byId.set(model.id, model);
	if (priceAuthority === "product") {
		for (const id of free) {
			if (byId.has(id)) continue;
			if (productConfig.source === "cache") {
				const row = productModelById(productConfig, id);
				const built = row === void 0 ? void 0 : productModelToCatalogRow(row);
				if (built !== void 0) {
					byId.set(built.id, built);
					continue;
				}
			}
			const builtin = BUILTIN_FREE_MODELS.find((model) => model.id === id);
			if (builtin !== void 0) byId.set(id, builtin);
		}
		for (const [id, model] of byId) {
			const row = productModelById(productConfig, id);
			const credits = row?.credits ?? BUILTIN_CREDITS[id];
			if (credits === void 0 && row === void 0) continue;
			byId.set(id, {
				...model,
				billing: {
					...model.billing,
					...credits === void 0 ? {} : { credits },
					free: free.has(id)
				}
			});
		}
	}
	return scope === "all" ? [...byId.values()] : [...byId.values()].filter((model) => free.has(model.id));
}
/**
* The plugin's live catalog.
*
* `scope` is mutable because the settings card can flip between "free only" and
* "all models" without a restart; the adapter rebuilds its snapshot from
* {@link current} on every read, so a change lands on the next request.
*/
var WorkBuddyCatalog = class {
	upstream = [];
	scope;
	productConfig;
	fallback;
	priceAuthority;
	/**
	* Models the user switched off in the card. Kept here rather than folded into
	* `scope` because the two answer different questions: the scope decides which
	* models are *offered*, this decides which of the offered ones the picker still
	* *lists*. Absent ids are enabled, so an install that never touched the
	* switches behaves exactly as before.
	*/
	disabled = /* @__PURE__ */ new Set();
	constructor(options) {
		this.productConfig = options.productConfig;
		this.scope = options.scope ?? "free";
		this.fallback = options.fallback ?? true;
		this.priceAuthority = options.priceAuthority ?? "product";
	}
	/** Replace the upstream rows; the effective list is recomposed immediately. */
	setUpstream(models) {
		this.upstream = [...models];
	}
	/** The upstream rows as last received, before any policy is applied. */
	upstreamModels() {
		return this.upstream;
	}
	/** Switch the billing policy; takes effect on the next {@link current} read. */
	setScope(scope) {
		this.scope = scope;
	}
	/**
	* Replace the set of models the picker must not list.
	*
	* This never touches {@link current}: the pi-ai snapshot that resolves a
	* request is built from it, so dropping a model here would turn a switched-off
	* model into `UNKNOWN_MODEL` for a session that had already selected it. The
	* filter is applied one layer up, in the adapter's `listModels`, which is what
	* the picker reads and the request path does not.
	*/
	setDisabled(ids) {
		this.disabled = new Set(ids);
	}
	/** The ids the picker must not list. */
	disabledIds() {
		return [...this.disabled];
	}
	/** Whether one model is switched off. */
	isDisabled(id) {
		return this.disabled.has(id);
	}
	/** The active billing policy. */
	currentScope() {
		return this.scope;
	}
	/** The product configuration this catalog prices against. */
	product() {
		return this.productConfig;
	}
	/** The effective entries; the fallback list until the upstream answer lands. */
	current() {
		if (!this.fallback && this.upstream.length === 0) return [];
		return composeCatalog(this.upstream, {
			productConfig: this.productConfig,
			scope: this.scope,
			priceAuthority: this.priceAuthority
		});
	}
	/** Every model in this region, before the free/all picker policy is applied. */
	all() {
		if (!this.fallback && this.upstream.length === 0) return [];
		return composeCatalog(this.upstream, {
			productConfig: this.productConfig,
			scope: "all",
			priceAuthority: this.priceAuthority
		});
	}
	/** Whether this region trusts upstream model billing instead of global product data. */
	usesUpstreamPricing() {
		return this.priceAuthority === "upstream";
	}
	/** Every model id this region prices as free. */
	freeIds() {
		if (this.priceAuthority === "upstream") return this.all().filter((model) => model.billing?.free === true).map((model) => model.id);
		return freeModelIds(this.productConfig);
	}
	/** Whether a model is free according to this region's authority. */
	isFree(id) {
		return this.freeIds().includes(id);
	}
	/** Display suffix for one row: the rate, then any promotional badges. */
	displaySuffix(id) {
		const model = this.current().find((entry) => entry.id === id);
		if (model === void 0) return void 0;
		const parts = [normalizeCredits(model.billing?.credits), ...model.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
		return parts.length === 0 ? void 0 : parts.join(" · ");
	}
};
//#endregion
//#region src/oauth.ts
/**
* Browser OAuth for the official WorkBuddy CLI login endpoints.
*
* Starts a CLI login at `/v2/plugin/auth/state`, opens `authUrl`, then polls
* `/v2/plugin/auth/token` until the user finishes in the browser (envelope
* code `11217` means still waiting). The resulting tokens are saved through
* {@link WorkBuddyCredentialStore.importCredential} — the desktop auth file
* is never written.
*
* Login `state` stays in process memory so a same-origin card cannot resume a
* poll it did not start.
*
* @module dsh-workbuddy/oauth
*/
/** Give up if the browser never finishes. */
const LOGIN_TIMEOUT_MS = 9e5;
/**
* Open `url` with the platform browser helper. Failures are non-fatal: the
* caller still returns the URL so the UI can offer a link.
*/
function openAuthUrl(url) {
	try {
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? [
			"/c",
			"start",
			"",
			url
		] : [url];
		spawn(command, args, {
			detached: true,
			stdio: "ignore"
		}).on("error", () => {}).unref();
		return true;
	} catch {
		return false;
	}
}
/**
* In-process CLI login. One instance per plugin; overlapping `start()` calls
* replace the previous wait.
*/
var WorkBuddyOAuthLogin = class {
	client;
	open;
	region;
	waiting;
	constructor(client, open = openAuthUrl, region = "global") {
		this.client = client;
		this.open = open;
		this.region = region;
	}
	/** Begin a login and try to open the browser. */
	async start() {
		const nonce = randomBytes(16).toString("hex");
		const started = await this.client.startPluginLogin(nonce, this.region);
		this.waiting = {
			state: started.state,
			authUrl: started.authUrl,
			startedAt: Date.now()
		};
		return {
			authUrl: started.authUrl,
			opened: this.open(started.authUrl)
		};
	}
	/**
	* One poll of the login `state`. `pending` means the user has not finished;
	* otherwise the caller must persist {@link WorkBuddyOAuthPoll.auth}.
	*/
	async poll() {
		const waiting = this.waiting;
		if (waiting === void 0) throw new Error("workbuddy-ai: no login in progress");
		if (Date.now() - waiting.startedAt > 9e5) {
			this.waiting = void 0;
			throw new Error("workbuddy-ai: login timed out");
		}
		const data = await this.client.pollPluginToken(waiting.state, this.region);
		if (data === void 0) return { pending: true };
		this.waiting = void 0;
		return { auth: credentialFromPluginToken(data, this.region) };
	}
	/** Drop an in-flight login without touching stored credentials. */
	cancel() {
		this.waiting = void 0;
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDY_VERSION = "1.0.2";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
* `workbuddy-ai` provider is registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported only
* through `console.error` on failure. This asymmetry is intentional: the host is
* the load-bearing half, and a missing heartbeat unambiguously means the host
* never started.
*
* @module dsh-workbuddy/host-heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-ai-host-heartbeat.json";
/** Package name stamped into the heartbeat, so readers can tell the two plugins apart. */
const HEARTBEAT_PACKAGE = "dsh-workbuddy";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function workBuddyHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and the
* status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: HEARTBEAT_PACKAGE,
		pluginVersion: WORKBUDDY_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(workBuddyHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(workBuddyHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(workBuddyHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === HEARTBEAT_PACKAGE && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: HEARTBEAT_PACKAGE,
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file) is
* distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it, so
*    `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID to
* an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
export { normalizeCredits as A, WORKBUDDY_CN_AUTH_FILENAME as B, acceptGrowthTasks as C, fetchGrowthStatus as D, fetchGrowthRewardToday as E, PROBE_EFFORT_CANDIDATES as F, WorkBuddyCredentialStore as G, WORKBUDDY_CN_DESKTOP_AUTH_BASENAME as H, probeModel as I, defaultDesktopAuthPath as J, credentialFromPluginToken as K, randomSentinel as L, regionOf as M, reportGrowthEvents as N, fetchGrowthTasks as O, runGrowthTrip as P, WORKBUDDY_AUTH_FILENAME as R, WorkBuddyUpstreamClient as S, classifyUpstreamError as T, WORKBUDDY_DESKTOP_AUTH_BASENAME as U, WORKBUDDY_CN_AUTH_FILE_ENV as V, WorkBuddyAccountStore as W, workBuddyOwnAuthPath as X, parseWorkBuddyAuth as Y, workBuddyRegionOwnAuthPath as Z, FALLBACK_FREE_MODEL_IDS as _, readHostHeartbeat as a, parseProductConfig as b, WORKBUDDY_VERSION as c, FALLBACK_WORKBUDDY_MODELS as d, WorkBuddyCatalog as f, FALLBACK_EXTRA_MODELS as g, BUILTIN_FREE_MODELS as h, processStartTimeMs as i, prepareChatBody as j, isFreeCredits as k, LOGIN_TIMEOUT_MS as l, BUILTIN_CREDITS as m, clearHostHeartbeat as n, workBuddyHostHeartbeatPath as o, composeCatalog as p, defaultDesktopAuthCandidates as q, isHeartbeatProcessAlive as r, writeHostHeartbeat as s, WORKBUDDY_HOST_HEARTBEAT_FILENAME as t, WorkBuddyOAuthLogin as u, freeModelIds as v, claimGrowthTask as w, workBuddyProductConfigPath as x, loadProductConfig as y, WORKBUDDY_AUTH_FILE_ENV as z };
