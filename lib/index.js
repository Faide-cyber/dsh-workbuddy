import { A as WORKBUDDY_CN_AUTH_FILE_ENV, B as workBuddyRegionOwnAuthPath, C as runGrowthTrip, D as WORKBUDDY_AUTH_FILENAME, E as randomSentinel, F as credentialFromPluginToken, I as defaultDesktopAuthCandidates, L as defaultDesktopAuthPath, M as WORKBUDDY_DESKTOP_AUTH_BASENAME, N as WorkBuddyAccountStore, O as WORKBUDDY_AUTH_FILE_ENV, P as WorkBuddyCredentialStore, R as parseWorkBuddyAuth, S as reportGrowthEvents, T as probeModel, _ as fetchGrowthTasks, a as readHostHeartbeat, b as prepareChatBody, c as WORKBUDDY_VERSION, d as WorkBuddyUpstreamClient, f as acceptGrowthTasks, g as fetchGrowthStatus, h as fetchGrowthRewardToday, i as processStartTimeMs, j as WORKBUDDY_CN_DESKTOP_AUTH_BASENAME, k as WORKBUDDY_CN_AUTH_FILENAME, l as LOGIN_TIMEOUT_MS, m as classifyUpstreamError, n as clearHostHeartbeat, o as workBuddyHostHeartbeatPath, p as claimGrowthTask, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME, u as WorkBuddyOAuthLogin, v as isFreeCredits, w as PROBE_EFFORT_CANDIDATES, x as regionOf, y as normalizeCredits, z as workBuddyOwnAuthPath } from "./host-heartbeat-BjuJc83F.js";
import z from "@deepseek-ai/schemastery";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
//#region src/catalog.ts
/**
* Apply the billing policy to the region's upstream rows.
*
* The filter runs last and only over the rows the region actually returned: an
* empty upstream yields an empty list, deliberately. A region with no answer
* yet must not borrow another region's models, or a sign-in to one deployment
* would advertise the other's lineup.
*
* @param upstream - rows from the live catalog; empty before the first fetch.
* @param options - the active billing policy.
* @returns the effective model list, upstream order preserved.
*/
function composeCatalog(upstream, options = {}) {
	const { scope = "free" } = options;
	if (scope === "all") return [...upstream];
	return upstream.filter((model) => model.billing?.free === true);
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
	/**
	* Models the user switched off in the card. Kept here rather than folded into
	* `scope` because the two answer different questions: the scope decides which
	* models are *offered*, this decides which of the offered ones the picker still
	* *lists*. Absent ids are enabled, so an install that never touched the
	* switches behaves exactly as before.
	*/
	disabled = /* @__PURE__ */ new Set();
	constructor(options = {}) {
		this.scope = options.scope ?? "free";
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
	/** The effective entries; empty until the region's catalog arrives. */
	current() {
		return composeCatalog(this.upstream, { scope: this.scope });
	}
	/** Every model in this region, before the free/all picker policy is applied. */
	all() {
		return composeCatalog(this.upstream, { scope: "all" });
	}
	/** Every model id this region prices as free. */
	freeIds() {
		return this.all().filter((model) => model.billing?.free === true).map((model) => model.id);
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
//#region src/model-switches.ts
/**
* Apply one switch write: memory, then the persistent store, then the picker.
*
* Memory leads so the next catalog read already reflects the change even while
* the store write is in flight. A store rejection still propagates — a switch
* that silently failed to persist is precisely the failure this ordering exists
* to surface on the card — but the notification fires either way, because live
* memory is what the picker reads: leaving it stale after a failed write would
* reproduce the original symptom, with the user unable to tell a broken switch
* from a stale cache.
*
* @param target - catalog whose disabled set is edited.
* @param models - model ids the switch applies to (one id, or a whole selection).
* @param enabled - `true` re-enables those ids, `false` disables them.
* @param persist - writes the resulting id list; the card waits on it.
* @param notify - tells the browser its cached model catalog is stale.
*/
async function applyModelSwitchWrite(target, models, enabled, persist, notify) {
	const next = new Set(target.disabledIds());
	for (const model of models) if (enabled) next.delete(model);
	else next.add(model);
	const ids = [...next];
	target.setDisabled(ids);
	try {
		await persist(ids);
	} finally {
		notify();
	}
}
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy-ai` pi-ai provider: one loopback-backed adapter registered into
* the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points.
*
* The route is deliberately a *separate provider id* from any domestic
* WorkBuddy route. Two providers would otherwise both claim `workbuddy` and the
* registry would refuse the second one; more importantly, a user running both
* the domestic and the international app needs both routes addressable at once,
* and distinct ids is what makes that possible.
*
* @module dsh-workbuddy/adapter
*/
/**
* Provider route this bundle owns.
*
* Distinct from the domestic plugin's `workbuddy` on purpose: both routes may be
* mounted in one profile, and the LLM registry rejects a second adapter claiming
* a route another already serves.
*/
const WORKBUDDY_PROVIDER = "workbuddy-ai";
/** Domestic route owned by this plugin; kept distinct from other WorkBuddy bundles. */
const WORKBUDDY_CN_PROVIDER = "workbuddy-cn";
/** Display name shown by the model picker and configuration surfaces. */
const WORKBUDDY_DISPLAY_NAME = "WorkBuddy 国际版";
const WORKBUDDY_CN_DISPLAY_NAME = "WorkBuddy 国内版";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Maximum base64-encoded image payload per request, at the dsh-llm-pi-ai
* default. It bounds requests to models whose catalog entry declares
* `supportsImages`; text-only models never receive images.
*/
const MAX_REQUEST_IMAGE_BYTES = 20971520;
/**
* Inert pi-ai ambient auth.
*
* The route authenticates only through the shim shared secret resolved per
* request by `resolveApiKey`, so pi-ai's own credential lifecycle and ambient
* discovery must never manufacture a credential for it. This provider declares
* no auth at all, which is what makes `resolveApiKey` authoritative.
*/
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Separator between a model's name and its billing rate.
*
* A middle dot rather than a hyphen or colon: model names already contain
* hyphens (`Deepseek-V4.1-Flash`), so a hyphen separator would be ambiguous
* about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/** The catalog display suffix: the billing rate, then any promo badges. */
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/**
* Append the catalog display suffix to one model's display name.
*
* Display-only, and it cannot affect routing: the wire request is built from
* `model.id`, the selection a picker submits is `{provider, model: id,
* reasoningEffort}`, and `dsh-llm` validates `name` as a non-empty string
* without comparing its contents. Nothing in the host resolves a model *by* name.
*/
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap` (every
* level pinned to its wire spelling or `null` for unsupported).
*
* Two sources, strictly ordered:
*
* 1. **The declared set.** When the row declares a non-empty `supportedEfforts`,
*    exactly those values are offered and nothing else. This always wins: an
*    observation never widens or narrows a declared set.
* 2. **A local observation.** A row with no declared set normally gets no
*    control at all — its selectable set is client-side knowledge the catalog
*    does not carry. If the user authorized a probe and it established that the
*    upstream *validates* the parameter, the verified spellings are offered.
*
* A `non-validating` observation deliberately yields no control: the upstream
* accepts values that cannot exist, so every per-level acceptance it produced
* would be a false positive.
*
* `off` is offered only when the row declares `canDisableThinking: true`. It is
* never probed — disabling thinking is a separate capability that cannot be
* inferred from per-level acceptance.
*/
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, provider, observed) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens
	};
}
/**
* Assemble the adapter.
*
* The provider's `getModels` reads the live catalog, and every model's `baseUrl`
* is re-resolved per read so the shim's ephemeral port applies from the first
* snapshot after startup. The profile is constructed by hand rather than through
* dsh-llm-pi-ai's internal `resolveProfiles()`: that helper is not part of the
* package's public export surface, so hand-assembly is the only supported path
* and every required field must be adopted here explicitly.
*/
function createWorkBuddyAdapter(options) {
	const { shim, catalog, resolveAttachments, observe } = options;
	const providerId = options.provider ?? "workbuddy-ai";
	const providerName = options.displayName ?? "WorkBuddy 国际版";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, providerId, observe?.(info.id)));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
		piProvider: provider,
		modelErrors: /* @__PURE__ */ new Map(),
		requestImagePixelBudget: 4194304,
		requestImageMaxBytes: 1048576
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, {
			profiles: () => profiles,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments },
			auth: {
				credentials: {
					async read() {},
					async list() {
						return [];
					},
					async modify() {
						throw new Error("dsh-workbuddy: the workbuddy-ai route has no pi-ai credential lifecycle");
					},
					async delete() {}
				},
				authContext: {
					async env() {},
					async fileExists() {
						return false;
					}
				}
			}
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The route's adapter: `PiAiAdapter` with the billing rate folded into the
* catalog answers it returns to the DSH model pickers.
*
* `listModels()` and `resolveModel()` build their answers straight from the
* pi-ai descriptors, which carry no billing fact, so the rate is layered on here
* by looking the model up in the live catalog. Both overrides delegate to
* `super` and then rewrite only the display fields, so streaming, capability
* resolution, and effort mapping stay exactly as `dsh-llm-pi-ai` implements them.
*
* A model missing from the catalog falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).filter((model) => !this.catalog.isDisabled(model.id)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/loopback.ts
/**
* Shared request gates for the plugin's local HTTP surfaces: the loopback shim
* and the same-origin web-status / control routes. Default is loopback-only.
* Operators may add extra Host/Origin authorities for LAN DSH Web without
* folding those names into {@link LOOPBACK_HOSTS}.
*
* @module dsh-workbuddy/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in Host,
* so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser clients
* (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Lowercase hostname from a configured authority (`host` or `host:port`). */
function normalizeAllowedHost(value) {
	return hostnameOfHost(value.trim().toLowerCase());
}
/**
* Host is trusted when it is loopback, or an explicitly configured extra
* authority. Extra hosts are never folded into {@link LOOPBACK_HOSTS}: listing
* a LAN IP there would also accept DNS-rebinding pages that spoof that Host.
*/
function hostIsTrusted(host, allowedHosts = []) {
	if (hostIsLoopback(host)) return true;
	if (host === void 0 || host.trim() === "") return false;
	const name = hostnameOfHost(host);
	return allowedHosts.some((entry) => normalizeAllowedHost(entry) === name);
}
/**
* Origin is trusted when absent (non-browser), loopback, or an extra host the
* operator listed. A present Origin from an unlisted host is rejected.
*/
function originIsTrusted(origin, allowedHosts = []) {
	if (originIsLoopback(origin)) return true;
	try {
		const { hostname } = new URL(origin ?? "");
		const name = hostname === "::1" ? "[::1]" : hostname.toLowerCase();
		return allowedHosts.some((entry) => {
			const allowed = normalizeAllowedHost(entry);
			return allowed === name || allowed === hostname.toLowerCase();
		});
	} catch {
		return false;
	}
}
/** Combined Host + Origin gate used by the card's status and control routes. */
function requestIsTrusted(req, allowedHosts = []) {
	return hostIsTrusted(req.headers.host, allowedHosts) && originIsTrusted(req.headers.origin, allowedHosts);
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint.
*
* The pi-ai provider points here; the shim applies the WorkBuddy wire quirks
* (forced streaming, string `tool_choice`, CLI-shaped headers, a leading system
* message) and forwards to the real upstream. It binds 127.0.0.1 only and never
* serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any local
* process or a DNS-rebinding page can reach 127.0.0.1), so every request must
* carry a loopback Host header, browser-sent Origins must be loopback, chat
* POSTs must be application/json, and the Authorization header must carry the
* shim's per-process shared secret. The plugin's own client satisfies all four
* by construction; local attackers cannot read the secret out of the plugin
* process's memory.
*
* @module dsh-workbuddy/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry the shim's own bearer; the
* upstream credential comes from the store alone and never reaches the caller.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy-ai shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy-ai"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody$1(req)).toString("utf8");
		const prepared = prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `workbuddy-ai upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddy: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. A result is
* invalidated whenever the model's catalog row changes, so every record carries
* a fingerprint of the fields the probe depended on.
*
* The file lives beside the plugin's own credential copy under `$DSH_HOME`,
* never in the desktop app's files, and carries no token, prompt, or response
* body — only model ids, effort spellings, and timestamps.
*
* @module dsh-workbuddy/probe-store
*/
/** Basename of the probe record inside the Harness home. */
const WORKBUDDY_PROBE_FILENAME = ".workbuddy-ai-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: upstream
* metadata moves fast, so a result that has outlived its fingerprint's
* usefulness should not quietly keep granting a picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/** Plugin-owned probe record path inside the Harness home. */
function workBuddyProbePath() {
	return join(resolveDshHome(), WORKBUDDY_PROBE_FILENAME);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a promo badge does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, never trusted
* across a fingerprint change or past the TTL.
*/
var WorkBuddyProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? workBuddyProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [id, record] of Object.entries(document?.records ?? {})) if (isRecord(record)) records[id] = record;
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for a model, or `undefined` when there is none, it is
	* expired, or it was taken against a different catalog row.
	*/
	get(modelId, fingerprint) {
		const record = this.load()[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation. Only a decisive answer (`validating` /
	* `non-validating`) replaces an existing decisive record: a transient
	* `unknown` must not erase knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const existing = records[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		records[modelId] = record;
		this.persist();
	}
	/** Drop every record; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/** Every record currently held, for status display. */
	all() {
		return { ...this.load() };
	}
	/** Build a record stamped with this store's clock and version. */
	record(fingerprint, validation, efforts) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
/**
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var WorkBuddyProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* A declared set always wins, so a model that declares `supportedEfforts` is
	* never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		return this.options.store.get(modelId, fingerprintModel(info));
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const pending = this.pending.get(modelId);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			const credential = await this.options.credentials.current();
			if (credential === void 0) return {
				state: "unavailable",
				reason: "no WorkBuddy credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(credential, modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(modelId, run);
		try {
			return await run;
		} finally {
			this.pending.delete(modelId);
		}
	}
};
//#endregion
//#region src/growth-tasks.ts
/**
* Task code to spec. Covers the whole domestic growth center; codes the
* upstream adds later are simply absent, which {@link isSkippedGrowthTask}
* treats as "do not touch".
*/
const GROWTH_TASK_SPECS = {
	create_canvas: {
		kind: "canvas",
		target: 1
	},
	template_5: {
		kind: "template",
		target: 5
	},
	expert_5: {
		kind: "expert",
		target: 5
	},
	Expert_team_use_3: {
		kind: "team",
		target: 3
	},
	skill_1: {
		kind: "skill",
		target: 1
	},
	automation_1: {
		kind: "automation",
		target: 1
	},
	playbook_prompt: {
		kind: "playbook",
		target: 1
	},
	Expert_lighthouse: {
		kind: "lighthouse",
		target: 1
	},
	Hp_Appearance: {
		kind: "skin",
		target: 1
	},
	chat_5: {
		kind: "chat",
		target: 5
	},
	"Model_chat_GLM5.2": {
		kind: "glmchat",
		target: 1
	},
	black_cat: {
		kind: "cat",
		target: 3
	},
	Buddy_App: {
		kind: "buddy5",
		target: 1
	},
	Buddy_App_QQ: {
		kind: "buddy5",
		target: 1
	},
	RichMeow_Chat: {
		kind: "richmeow",
		target: 1
	},
	Library_read: {
		kind: "library",
		target: 1
	},
	first_buddy: {
		kind: "buddy_first",
		target: 1
	},
	Expert_Philanthropy: {
		kind: "unforgeable",
		target: 1
	}
};
/**
* Kinds the orchestrator must never report.
*
* `buddy5`/`richmeow`/`library` have no event branch (a report cannot light
* them), `buddy_first` is driven by the adoption state machine instead, and
* `unforgeable` is a real donation — reporting it would be a lie about money.
*/
const GROWTH_SKIP_KINDS = /* @__PURE__ */ new Set([
	"buddy5",
	"richmeow",
	"library",
	"buddy_first",
	"unforgeable"
]);
/** The spec for a task code, or `undefined` when the code is unknown. */
function growthTaskSpec(code) {
	return Object.prototype.hasOwnProperty.call(GROWTH_TASK_SPECS, code) ? GROWTH_TASK_SPECS[code] : void 0;
}
/**
* Whether the orchestrator should leave this task alone.
*
* Unknown codes count as skipped: the alternative is reporting an event whose
* meaning we are guessing, which is how a "helpful" pass ends up creating a
* task state the upstream never offered.
*/
function isSkippedGrowthTask(code) {
	const spec = growthTaskSpec(code);
	return spec === void 0 || GROWTH_SKIP_KINDS.has(spec.kind);
}
/** Kinds that only light up inside the night window. */
const GROWTH_NIGHT_KINDS = /* @__PURE__ */ new Set(["cat"]);
/**
* Whether the night-only task may be lit now, in Beijing wall-clock time.
*
* The upstream judges by its own `23:00-08:00` window; reports outside it are
* accepted and ignored, so sending them only wastes a round trip.
*/
function inGrowthNightWindow(nowMs = Date.now()) {
	const beijingHour = new Date(nowMs + 288e5).getUTCHours();
	return beijingHour >= 23 || beijingHour < 8;
}
/**
* Build one report event for a task kind.
*
* `uid` is the account uid and must be present: without it the upstream accepts
* the batch and counts nothing. `idx` only has to keep the generated ids apart
* within one task — the server does not cross-check them against a real session.
*/
function buildGrowthEvent(uid, kind, idx = 0) {
	const now = Date.now();
	const conversationId = `dsh-growth-${now}-${idx}`;
	const requestId = `${conversationId}-req`;
	const userId = uid;
	switch (kind) {
		case "canvas": return {
			eventCode: "wbx_design_canvas_task_create",
			timestamp: now,
			reportDelay: 0,
			conversationId,
			requestId,
			source: "summon_keyword",
			isCustomModel: false,
			name: "",
			inputLength: 12,
			id: `wbx-canvas-${now}`,
			cost: 0,
			isSuccessful: true,
			userId
		};
		case "template": return {
			eventCode: "agent_task_created_with_template",
			timestamp: now,
			reportDelay: 0,
			isCustomModel: true,
			id: String(idx),
			name: "幻灯片",
			requestId,
			conversationId,
			userId
		};
		case "expert":
		case "team":
		case "lighthouse": {
			const expertType = kind === "team" ? "team" : "agent";
			const expertId = kind === "lighthouse" ? "ex_2cvvUZQhDyeJ" : kind === "team" ? "CloudOpsTeam" : "ContentCreator";
			const name = kind === "lighthouse" ? "腾讯轻量云专家" : kind === "team" ? "运维专家团队" : "内容创作专家";
			return {
				eventCode: "expert_actual_use",
				timestamp: now,
				reportDelay: 0,
				mode: "CLOUD",
				id: idx === 0 ? expertId : `${expertId}-${idx}`,
				name,
				expertTitle: name,
				type: "02-Engineering",
				expertType,
				source: "builtin",
				version: "1.0.2",
				cost: 0,
				characterCount: 12,
				conversationId,
				requestId,
				messageId: requestId,
				requestModelId: "deepseek-v4-flash",
				requestModelName: "DeepSeek V4 Flash",
				userId
			};
		}
		case "skill": return {
			eventCode: "skill_info",
			timestamp: now,
			reportDelay: 0,
			skillId: "skill_2096525080079265792",
			name: "pptx",
			userId
		};
		case "automation": return {
			eventCode: "automated_task_create_suc",
			timestamp: now,
			reportDelay: 0,
			name: "每周工作整理",
			type: "cron",
			source: "manually",
			modelId: "deepseek-v4-flash",
			modelIsThinking: false,
			conversationId,
			requestId,
			schedule: {
				type: "recurring",
				rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0"
			},
			prompt: "每周五自动整理本周工作",
			userId
		};
		case "playbook": return {
			eventCode: "playbook_prompt_send",
			timestamp: now,
			reportDelay: 0,
			id: "worker-ledger-freedom-dashboard",
			name: "打工人小账本",
			type: "other",
			promptLength: 10,
			isOfficial: 1,
			source: "discover",
			conversationId,
			requestId,
			userId
		};
		case "skin": return {
			eventCode: "appearance_skin_apply",
			timestamp: now,
			reportDelay: 0,
			action: "apply",
			source: "settings_close",
			id: "theme-tkmw7j",
			vipLevel: "free",
			series: "craft",
			type: "unknown",
			name: "和平精英激战金秋",
			userId
		};
		case "chat":
		case "glmchat":
		case "cat": {
			const night = kind === "cat";
			return {
				eventCode: "chat_request_send",
				timestamp: now,
				reportDelay: 0,
				mode: night ? "night" : "craft",
				conversationId,
				requestId,
				inputLength: 12,
				requestModelId: night || kind === "glmchat" ? "glm-5.2" : "deepseek-v4-flash",
				requestModelName: night || kind === "glmchat" ? "GLM-5.2" : "DeepSeek V4 Flash",
				isPlan: false,
				agentName: "default",
				agentType: "conversation",
				userId
			};
		}
		default: return {
			eventCode: "heartbeat",
			timestamp: now,
			userId
		};
	}
}
//#endregion
//#region src/provider-rows.ts
/**
* Registration is all-or-nothing per region: if the directory entry is refused
* after the adapter landed, the adapter is rolled back so the region cannot be
* left half-registered and therefore listed but unusable.
*/
function createProviderRows(registrar, specs) {
	const held = /* @__PURE__ */ new Map();
	const release = (region) => {
		const releases = held.get(region);
		if (releases === void 0) return;
		held.delete(region);
		for (const undo of [...releases].reverse()) undo();
	};
	return {
		setLive(region, live) {
			const spec = specs.get(region);
			if (spec === void 0) return;
			if (!live) {
				release(region);
				return;
			}
			if (held.has(region)) return;
			const releases = [];
			held.set(region, releases);
			try {
				releases.push(registrar.registerAdapter([spec.provider], spec.adapter));
				releases.push(registrar.registerConfigurableProviders([{
					provider: spec.provider,
					displayName: spec.displayName,
					settingsNs: spec.settingsNs,
					settingsPath: [],
					declared: false
				}]));
			} catch (error) {
				release(region);
				throw error;
			}
		},
		releaseAll() {
			for (const region of [...held.keys()]) release(region);
		},
		liveRegions() {
			return [...held.keys()];
		}
	};
}
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the Host and browser halves.
*
* @module dsh-workbuddy/status-paths
*/
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy/status";
/**
* Plugin-owned control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore also
* requires the in-process key the browser half receives with the status document.
*/
const WORKBUDDY_CONTROL_PATH = "/plugins/dsh-workbuddy/control";
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback); the
* card's same-origin fetches carry no Origin and pass on Host alone.
*/
function trustedRequest(req, allowedHosts) {
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
	return requestIsTrusted({ headers: {
		...req.headers.host === void 0 ? {} : { host: req.headers.host },
		...origin === void 0 ? {} : { origin }
	} }, allowedHosts);
}
function modelBadges(catalog) {
	const selectable = new Set(catalog.current().map((model) => model.id));
	return catalog.all().map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges === void 0 ? {} : { badges: model.billing.badges },
			...rate === void 0 ? {} : { credits: rate },
			...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
			selectable: selectable.has(model.id),
			enabled: !catalog.isDisabled(model.id)
		};
	});
}
/** Build one token-free region section and respect the active/inactive cache cadence. */
async function buildRegionStatus(options, activeMinutes, inactiveMinutes, autoCheckin, checkinStates, growthStates, taskStates) {
	const accountRows = await options.store.accounts();
	const snapshots = await options.store.refreshCreditSnapshots((credential) => options.client.fetchCredits(credential), Math.max(1, activeMinutes) * 6e4, Math.max(1, inactiveMinutes) * 6e4);
	const accounts = accountRows.map((account) => {
		const snapshot = snapshots.get(account.id);
		const checkin = checkinStates?.get(account.id);
		const growth = growthStates?.get(account.id);
		const tasks = taskStates?.get(account.id);
		return {
			id: account.id,
			...account.nickname === void 0 ? {} : { nickname: account.nickname },
			...account.note === void 0 ? {} : { note: account.note },
			...account.domain === void 0 ? {} : { domain: account.domain },
			source: account.source,
			expiresAt: account.expiresAtMs,
			selected: account.selected,
			checkinEnabled: account.checkinEnabled,
			...checkin === void 0 ? {} : { checkin },
			...growth === void 0 ? {} : { growth },
			...tasks === void 0 ? {} : { tasks },
			...snapshot?.credits === void 0 ? {} : { credits: snapshot.credits },
			...snapshot?.error === void 0 ? {} : { creditsError: safeMessage(snapshot.error) }
		};
	});
	const selectedAccountId = options.store.selectedId();
	return {
		region: options.region,
		signedIn: accounts.length > 0,
		...selectedAccountId === void 0 ? {} : { selectedAccountId },
		accounts,
		...options.catalog.all().length === 0 ? {} : { models: modelBadges(options.catalog) },
		scope: options.catalog.currentScope(),
		freeIds: options.catalog.freeIds(),
		priceSource: "upstream",
		...options.probe === void 0 ? {} : { probe: options.probe() },
		checkin: {
			supported: options.region === "cn",
			enabled: options.region === "cn" && autoCheckin
		}
	};
}
/**
* Assemble the card's status document. Sign-in state is read-only; credit is a
* live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyAiWebStatus(deps) {
	const policy = deps.refreshPolicy?.() ?? {
		activeMinutes: 15,
		inactiveMinutes: 60
	};
	const regionStatuses = [];
	for (const region of ["global", "cn"]) {
		const options = deps.regions?.[region];
		if (options === void 0) continue;
		regionStatuses.push(await buildRegionStatus(options, policy.activeMinutes, policy.inactiveMinutes, deps.autoCheckin?.() ?? false, deps.checkinStates, deps.growthStates, deps.taskStates));
	}
	const authStatus = await deps.store.status();
	const hasRegionSignIn = regionStatuses.some((region) => region.signedIn);
	if (authStatus.state !== "signed-in" && !hasRegionSignIn) return {
		status: "signed-out",
		...regionStatuses.length === 0 ? {} : { regions: regionStatuses },
		...deps.controlKey === void 0 ? {} : { controlKey: deps.controlKey }
	};
	const selectedAuth = authStatus.state === "signed-in" ? authStatus : void 0;
	const catalog = deps.catalog;
	const freeIds = catalog.freeIds();
	const modelsField = modelBadges(catalog);
	const status = {
		status: "signed-in",
		...selectedAuth?.nickname === void 0 ? {} : { nickname: selectedAuth.nickname },
		...selectedAuth?.domain === void 0 || selectedAuth.domain === "" ? {} : { domain: selectedAuth.domain },
		...selectedAuth?.source === void 0 ? {} : { source: selectedAuth.source },
		...selectedAuth?.expiresAtMs === void 0 ? {} : { expiresAt: selectedAuth.expiresAtMs },
		...modelsField.length === 0 ? {} : { models: modelsField },
		scope: catalog.currentScope(),
		freeIds,
		priceSource: "upstream",
		...regionStatuses.length === 0 ? {} : { regions: regionStatuses },
		refreshPolicy: policy,
		autoCheckin: deps.autoCheckin?.() ?? false,
		...deps.probe === void 0 ? {} : { probe: deps.probe() },
		...deps.controlKey === void 0 ? {} : { controlKey: deps.controlKey }
	};
	try {
		const global = deps.regions?.global;
		if (global !== void 0) {
			const selectedId = global.store.selectedId();
			const cached = selectedId === void 0 ? void 0 : global.store.creditSnapshot(selectedId);
			if (cached?.credits !== void 0) return {
				...status,
				credits: cached.credits
			};
		}
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...status,
				credits
			};
		}
	} catch (error) {
		return {
			...status,
			creditsError: safeMessage(error)
		};
	}
	return status;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyAiStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!trustedRequest(req, deps.allowedHosts?.() ?? [])) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$1(res, 200, await workBuddyAiWebStatus(deps));
		} catch (error) {
			json$1(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_STATUS_PATH,
			handler: workBuddyAiStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy: Web status route");
}
//#endregion
//#region src/control-route.ts
/**
* Control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things:
*
* 1. **Trusted Host + Origin**, shared with the status route. Loopback is
*    always allowed; extra LAN authorities must be listed in `allowedHosts`.
*    This drops DNS-rebinding pages, whose Host is the attacker's domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local process
*    can write `Host: 127.0.0.1` — so a route that can spend the user's credit
*    (a probe) or expose paid models must prove the caller was told the key.
*
* The route never accepts a prompt, a model id outside the live catalog, or a
* sentinel from the browser: a probe request is assembled entirely host-side.
*
* @module dsh-workbuddy/control-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createControlKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function safeControlError(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clearProbe") return { action: "clearProbe" };
	if (action === "setScope") {
		const scope = wrapped["scope"];
		if (scope !== "free" && scope !== "all") return void 0;
		const region = wrapped["region"];
		if (region !== void 0 && region !== "cn" && region !== "global") return void 0;
		return {
			action: "setScope",
			scope,
			...region === void 0 ? {} : { region }
		};
	}
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
	if (action === "loginStart" || action === "loginPoll" || action === "logout") {
		const region = wrapped["region"];
		return region === void 0 ? { action } : region === "cn" || region === "global" ? {
			action,
			region
		} : void 0;
	}
	if (action === "selectAccount" || action === "removeAccount") {
		const region = wrapped["region"];
		const accountId = wrapped["accountId"];
		if (region !== "cn" && region !== "global" || typeof accountId !== "string" || accountId.trim() === "") return void 0;
		return {
			action,
			region,
			accountId: accountId.trim()
		};
	}
	if (action === "setAccountNote") {
		const region = wrapped["region"];
		const accountId = wrapped["accountId"];
		const note = wrapped["note"];
		if (region !== "cn" && region !== "global" || typeof accountId !== "string" || accountId.trim() === "" || typeof note !== "string" || note.length > 80) return void 0;
		return {
			action,
			region,
			accountId: accountId.trim(),
			note: note.trim()
		};
	}
	if (action === "setCheckinEnabled") {
		const accountId = wrapped["accountId"];
		const enabled = wrapped["enabled"];
		if (typeof accountId !== "string" || accountId.trim() === "" || typeof enabled !== "boolean") return void 0;
		return {
			action,
			accountId: accountId.trim(),
			enabled
		};
	}
	if (action === "checkin") {
		const accountId = wrapped["accountId"];
		if (typeof accountId !== "string" || accountId.trim() === "") return void 0;
		return {
			action,
			accountId: accountId.trim()
		};
	}
	if (action === "connectivity") {
		const region = wrapped["region"];
		const accountId = wrapped["accountId"];
		if (region !== "cn" && region !== "global") return void 0;
		return {
			action,
			region,
			...typeof accountId === "string" && accountId.trim() !== "" ? { accountId: accountId.trim() } : {}
		};
	}
	if (action === "setRefreshPolicy") {
		const activeMinutes = wrapped["activeMinutes"];
		const inactiveMinutes = wrapped["inactiveMinutes"];
		if (typeof activeMinutes !== "number" || !Number.isFinite(activeMinutes) || activeMinutes < 1 || typeof inactiveMinutes !== "number" || !Number.isFinite(inactiveMinutes) || inactiveMinutes < 1) return void 0;
		return {
			action,
			activeMinutes,
			inactiveMinutes
		};
	}
	if (action === "setAutoCheckin" && typeof wrapped["enabled"] === "boolean") return {
		action,
		enabled: wrapped["enabled"]
	};
	if (action === "setModelEnabled") {
		const model = wrapped["model"];
		const enabled = wrapped["enabled"];
		const region = wrapped["region"];
		if (typeof model !== "string" || model.trim() === "" || typeof enabled !== "boolean") return void 0;
		if (region !== void 0 && region !== "cn" && region !== "global") return void 0;
		return {
			action,
			model: model.trim(),
			enabled,
			...region === void 0 ? {} : { region }
		};
	}
	if (action === "setModelsEnabled") {
		const models = wrapped["models"];
		const enabled = wrapped["enabled"];
		const region = wrapped["region"];
		if (!Array.isArray(models) || models.length === 0 || models.length > 500) return void 0;
		const ids = [];
		for (const model of models) {
			if (typeof model !== "string" || model.trim() === "") return void 0;
			ids.push(model.trim());
		}
		if (typeof enabled !== "boolean") return void 0;
		if (region !== void 0 && region !== "cn" && region !== "global") return void 0;
		return {
			action,
			models: ids,
			enabled,
			...region === void 0 ? {} : { region }
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare server
* with a known key.
*/
function workBuddyAiControlHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
		if (!requestIsTrusted({ headers: {
			...req.headers.host === void 0 ? {} : { host: req.headers.host },
			...origin === void 0 ? {} : { origin }
		} }, deps.allowedHosts?.() ?? [])) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-workbuddy-control-key"])) {
			json(res, 403, { error: "invalid-control-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json(res, 400, { error: "invalid action" });
			return;
		}
		try {
			switch (action.action) {
				case "clearProbe":
					deps.clearProbe();
					json(res, 200, { state: "cleared" });
					return;
				case "setScope":
					deps.setScope(action.scope, action.region);
					json(res, 200, {
						state: "ok",
						scope: action.scope
					});
					return;
				case "probe":
					json(res, 200, await deps.probe(action.model));
					return;
				case "loginStart":
					json(res, 200, {
						state: "ok",
						authUrl: (await deps.loginStart(action.region)).authUrl
					});
					return;
				case "loginPoll":
					if ("pending" in await deps.loginPoll(action.region)) {
						json(res, 200, {
							state: "ok",
							pending: true
						});
						return;
					}
					json(res, 200, { state: "ok" });
					return;
				case "logout":
					await deps.logout(action.region);
					json(res, 200, { state: "ok" });
					return;
				case "selectAccount":
					if (deps.selectAccount === void 0) throw new Error("account selection is unavailable");
					await deps.selectAccount(action.region, action.accountId);
					json(res, 200, { state: "ok" });
					return;
				case "removeAccount":
					if (deps.removeAccount === void 0) throw new Error("account removal is unavailable");
					await deps.removeAccount(action.region, action.accountId);
					json(res, 200, { state: "ok" });
					return;
				case "setAccountNote":
					if (deps.setAccountNote === void 0) throw new Error("account notes are unavailable");
					json(res, 200, {
						state: "ok",
						note: await deps.setAccountNote(action.region, action.accountId, action.note) ?? null
					});
					return;
				case "setCheckinEnabled":
					if (deps.setCheckinEnabled === void 0) throw new Error("check-in settings are unavailable");
					await deps.setCheckinEnabled(action.accountId, action.enabled);
					json(res, 200, { state: "ok" });
					return;
				case "checkin":
					if (deps.checkin === void 0) throw new Error("check-in is unavailable");
					json(res, 200, {
						state: "ok",
						checkin: await deps.checkin(action.accountId)
					});
					return;
				case "connectivity":
					if (deps.connectivity === void 0) throw new Error("connectivity test is unavailable");
					json(res, 200, await deps.connectivity(action.region, action.accountId));
					return;
				case "setRefreshPolicy":
					if (deps.setRefreshPolicy === void 0) throw new Error("refresh policy is unavailable");
					await deps.setRefreshPolicy(action.activeMinutes, action.inactiveMinutes);
					json(res, 200, { state: "ok" });
					return;
				case "setAutoCheckin":
					if (deps.setAutoCheckin === void 0) throw new Error("auto check-in is unavailable");
					await deps.setAutoCheckin(action.enabled);
					json(res, 200, { state: "ok" });
					return;
				case "setModelEnabled":
					if (deps.setModelEnabled === void 0) throw new Error("model switches are unavailable");
					await deps.setModelEnabled(action.model, action.enabled, action.region);
					json(res, 200, { state: "ok" });
					return;
				case "setModelsEnabled":
					if (deps.setModelsEnabled === void 0) throw new Error("model switches are unavailable");
					await deps.setModelsEnabled(action.models, action.enabled, action.region);
					json(res, 200, { state: "ok" });
					return;
			}
		} catch (error) {
			json(res, 500, { error: safeControlError(error) });
		}
	};
}
/** Mount the POST control route on an optional webServer context. */
function registerWorkBuddyControlRoute(ctx, deps, key) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_CONTROL_PATH,
			handler: workBuddyAiControlHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy: control route");
}
//#endregion
//#region src/settings-file.ts
/**
* Card-edited configuration, kept in the plugin's own file under `$DSH_HOME`.
*
* The DSH settings service is the natural home for this, and the plugin still
* registers with it (that is what puts the provider on the Models settings
* page), but it is not a reliable *write* path here: registration never
* completed in this profile, so every card edit was lost on restart. A switch
* that does not stick is worse than one that says it is temporary, so the edits
* live in a file this plugin owns end to end.
*
* The file sits beside the plugin's credential copy, carries no token or
* prompt, and is read back through {@link sanitizeSavedConfig}: a file on disk
* is untrusted input, and a hand-edited one must not be able to inject a value
* the schema would have rejected.
*
* @module dsh-workbuddy/settings-file
*/
/** Basename of the plugin-owned settings file inside the Harness home. */
const WORKBUDDY_SETTINGS_FILENAME = ".workbuddy-ai-settings.json";
/** Plugin-owned settings path inside the Harness home. */
function workBuddySettingsPath() {
	return join(resolveDshHome(), WORKBUDDY_SETTINGS_FILENAME);
}
/**
* Read the stored edits, or `{}` when there is no file, it is unreadable, or it
* is not a JSON object. Never throws: a missing or damaged file means "nothing
* was saved", which is exactly the pre-file behaviour.
*/
function readWorkBuddySettings(path = workBuddySettingsPath()) {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/**
* Write the stored edits atomically. Unlike the probe store this **throws** on
* failure: the control route turns that into a 500 the card renders, and a
* silent no-op is precisely the bug this file exists to fix.
*/
function writeWorkBuddySettings(values, path = workBuddySettingsPath()) {
	const directory = dirname(path);
	if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
	const temporary = resolve(`${path}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 384 });
	renameSync(temporary, path);
}
/** Keys the card may edit, and the check each value must pass to be trusted. */
const SAVED_FIELDS = {
	authFile: (value) => typeof value === "string" ? value : void 0,
	cnAuthFile: (value) => typeof value === "string" ? value : void 0,
	refreshActiveMinutes: (value) => typeof value === "number" && value >= 1 ? value : void 0,
	refreshInactiveMinutes: (value) => typeof value === "number" && value >= 1 ? value : void 0,
	autoCheckin: (value) => typeof value === "boolean" ? value : void 0,
	probeConsent: (value) => typeof value === "boolean" ? value : void 0,
	modelScope: (value) => scope(value),
	cnModelScope: (value) => scope(value),
	disabledModels: (value) => strings(value),
	cnDisabledModels: (value) => strings(value),
	allowedHosts: (value) => strings(value)
};
function scope(value) {
	return value === "free" || value === "all" ? value : void 0;
}
function strings(value) {
	if (!Array.isArray(value)) return void 0;
	return value.every((entry) => typeof entry === "string") ? [...value] : void 0;
}
/**
* Keep only the known fields whose stored value still passes the schema's
* check. An unknown key or a wrong-typed value is dropped rather than trusted:
* the alternative is a hand-edited file deciding what the plugin runs with.
*/
function sanitizeSavedConfig(raw) {
	const saved = {};
	for (const [key, check] of Object.entries(SAVED_FIELDS)) {
		if (!(key in raw)) continue;
		const value = check(raw[key]);
		if (value !== void 0) saved[key] = value;
	}
	return saved;
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddy-ai";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the configuration card.
*
* A namespace is a nominal string, validated by the type system where it is used
* rather than at runtime. The cast is applied once here so the public constant
* carries the seam's type without pulling the brand helper into this package.
*/
const WORKBUDDY_SETTINGS_NS = "workbuddy-ai";
const Config = z.object({
	authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)"),
	cnAuthFile: z.string().description("Domestic WorkBuddy desktop auth file (defaults to the app's own location)"),
	refreshActiveMinutes: z.number().min(1).default(15).description("Read-only refresh interval for the selected account"),
	refreshInactiveMinutes: z.number().min(1).default(60).description("Read-only refresh interval for other accounts"),
	autoCheckin: z.boolean().default(false).description("Automatically check in selected domestic accounts once per day"),
	probeConsent: z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)"),
	modelScope: z.union([z.const("free"), z.const("all")]).default("free").description("Which international models to offer: free only (default), or every model including paid ones"),
	cnModelScope: z.union([z.const("free"), z.const("all")]).default("free").description("Which domestic models to offer: free only (default), or every model including paid ones"),
	disabledModels: z.array(z.string()).default([]).description("International models the model picker should not list (already-selected models keep working)"),
	cnDisabledModels: z.array(z.string()).default([]).description("Domestic models the model picker should not list (already-selected models keep working)"),
	allowedHosts: z.array(z.string()).default([]).description("Extra Host names for the plugin card when DSH Web is opened over LAN (empty = loopback only)")
});
/**
* Start the loopback endpoint, register the `workbuddy-ai` provider, and refresh
* the model catalog from the upstream once credentials allow it. The list is
* empty until a region answers: both regions are priced from their own live
* catalog, so there is no local list to fall back to.
*/
function apply(ctx, config) {
	const client = new WorkBuddyUpstreamClient();
	const store = new WorkBuddyAccountStore({
		region: "global",
		...config.authFile === void 0 ? {} : { desktopPath: config.authFile },
		refresh: (credential) => client.refreshToken(credential)
	});
	const cnStore = new WorkBuddyAccountStore({
		region: "cn",
		...config.cnAuthFile === void 0 ? {} : { desktopPath: config.cnAuthFile },
		refresh: (credential) => client.refreshToken(credential)
	});
	const oauth = new WorkBuddyOAuthLogin(client, void 0, "global");
	const cnOauth = new WorkBuddyOAuthLogin(client, void 0, "cn");
	let base = () => config;
	const saved = sanitizeSavedConfig(readWorkBuddySettings());
	const current = () => ({
		...base(),
		...saved
	});
	const catalog = new WorkBuddyCatalog({ scope: current().modelScope ?? "free" });
	const cnCatalog = new WorkBuddyCatalog({ scope: current().cnModelScope ?? current().modelScope ?? "free" });
	store.setDesktopPath(current().authFile);
	cnStore.setDesktopPath(current().cnAuthFile);
	catalog.setDisabled(current().disabledModels ?? []);
	cnCatalog.setDisabled(current().cnDisabledModels ?? []);
	const shim = createWorkBuddyShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	const cnShim = createWorkBuddyShim({
		store: cnStore,
		client,
		catalog: cnCatalog,
		logger: ctx.logger
	});
	/**
	* Apply a card-driven config edit: in memory first, so the switch moves, then
	* to the file. A write failure propagates — the card renders it, and a silent
	* no-op is exactly what made the switch look broken.
	*/
	const persistConfigPatch = (patch) => {
		Object.assign(saved, patch);
		writeWorkBuddySettings(saved);
	};
	const refreshPolicy = () => ({
		activeMinutes: Math.max(1, current().refreshActiveMinutes ?? 15),
		inactiveMinutes: Math.max(1, current().refreshInactiveMinutes ?? 60)
	});
	const autoCheckin = () => current().autoCheckin === true;
	const refreshCredits = async () => {
		const policy = refreshPolicy();
		const fetch = (credential) => client.fetchCredits(credential);
		await Promise.all([store.refreshCreditSnapshots(fetch, policy.activeMinutes * 6e4, policy.inactiveMinutes * 6e4), cnStore.refreshCreditSnapshots(fetch, policy.activeMinutes * 6e4, policy.inactiveMinutes * 6e4)]);
	};
	const probeStore = new WorkBuddyProbeStore({ pluginVersion: WORKBUDDY_VERSION });
	const probeService = new WorkBuddyProbeService({
		store: probeStore,
		catalog,
		credentials: store,
		client,
		consent: () => current().probeConsent === true
	});
	/**
	* Whether a model can be probed by hand: it reasons and the upstream declares
	* no effort set for it.
	*
	* Deliberately *not* filtered by whether a result already exists. Dropping a
	* model once it has been detected made the list shrink with use, so
	* re-detecting one model meant clearing every other result first. The list
	* stays stable and the card marks which entries already have an answer.
	*/
	const isProbeCandidate = (info) => {
		if (info.reasoning?.supports !== true) return false;
		return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
	};
	/** Compact probe state for the card: consent, candidates, observations. */
	const probeSection = () => {
		const models = catalog.current();
		const results = models.flatMap((info) => {
			const record = probeService.recordFor(info.id);
			if (record === void 0) return [];
			return [{
				id: info.id,
				name: info.name,
				validation: record.validation,
				efforts: record.efforts,
				probedAt: record.probedAtMs
			}];
		});
		return {
			consent: current().probeConsent === true,
			running: probeService.isRunning(),
			candidates: models.filter(isProbeCandidate).map((info) => info.id),
			results: newestFirst(results)
		};
	};
	const controlKey = createControlKey();
	let refreshModels = () => {};
	/**
	* The provider rows this plugin offers, one per region. Undefined until the
	* loopback endpoint is up; the row appears on sign-in and leaves on sign-out,
	* because DSH has no way to list a provider "greyed out" — a registered route
	* is an offered route.
	*/
	let rows;
	/** Add each region's provider row only while that region has credentials. */
	const syncProviderRows = async () => {
		const live = rows;
		if (live === void 0) return;
		for (const region of ["global", "cn"]) try {
			live.setLive(region, await storeFor(region).current() !== void 0);
		} catch (error) {
			ctx.logger.warn(`dsh-workbuddy: could not read ${region} credentials`, error);
		}
	};
	/** Latest check-in read per account, so the card can show today's credit. */
	const checkinStates = /* @__PURE__ */ new Map();
	/** Growth-plan state per account, plus today's payout when one landed. */
	const growthStates = /* @__PURE__ */ new Map();
	/** Accounts already dispatched or claimed today; the upstream limit is the real guard. */
	const lastGrowthDate = /* @__PURE__ */ new Map();
	/** Growth tasks still unclaimed per account, from the last sweep. */
	const taskStates = /* @__PURE__ */ new Map();
	/** Accounts whose whole day is finished, keyed by account id -> date. */
	const autoCheckinDone = /* @__PURE__ */ new Map();
	const today = () => (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA");
	const delay = async (ms) => {
		await new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	};
	/**
	* Spacing between reported events. The upstream settles a report asynchronously
	* and quietly drops the ones that arrive too fast, so this is a correctness
	* knob, not politeness — lowering it makes tasks silently stop completing.
	*/
	const GROWTH_REPORT_GAP_MS = 1500;
	/** Time allowed for a report burst (or an accept) to move the counters. */
	const GROWTH_SETTLE_MS = 1500;
	/** How long the button waits for the task sweep before answering anyway. */
	const CHECKIN_SWEEP_WAIT_MS = 4e3;
	const storeFor = (region) => region === "cn" ? cnStore : store;
	const oauthFor = (region) => region === "cn" ? cnOauth : oauth;
	const catalogFor = (region) => region === "cn" ? cnCatalog : catalog;
	const safeReason = (error) => (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 300);
	const doCheckin = async (accountId) => {
		try {
			const credential = await cnStore.resolveFor(accountId);
			const status = await client.fetchCheckinStatus(credential);
			checkinStates.set(accountId, status);
			if (status.todayCheckedIn) return { state: "already-checked-in" };
			await client.claimDailyCheckin(credential);
			try {
				checkinStates.set(accountId, await client.fetchCheckinStatus(credential));
			} catch {}
			return { state: "checked-in" };
		} catch (error) {
			return {
				state: "error",
				reason: safeReason(error)
			};
		}
	};
	/**
	* Read the buddy's state together with today's payout.
	*
	* Two calls, because `/status` reports `reward_credit: 0` once the buddy is
	* idle and the card would then say "今日旅行已完成" while hiding the credits.
	* The `/records` read is best-effort: a failure there still leaves a usable
	* state line, just without the amount.
	*/
	const readGrowth = async (credential) => {
		const growth = await fetchGrowthStatus(credential);
		try {
			const claimedToday = await fetchGrowthRewardToday(credential, today());
			return claimedToday === void 0 ? growth : {
				...growth,
				claimedToday
			};
		} catch {
			return growth;
		}
	};
	/**
	* One growth-plan trip per account: claim what has arrived, otherwise send the
	* buddy out. Idempotent — the upstream daily limit is the real guard, this
	* only avoids re-reading the status on every 5-minute tick.
	*/
	const runGrowth = async (accountId) => {
		try {
			const credential = await cnStore.resolveFor(accountId);
			const result = await runGrowthTrip(credential);
			if (result.dispatched || result.claimed !== void 0) {
				lastGrowthDate.set(accountId, today());
				refreshCredits();
			}
			try {
				growthStates.set(accountId, await readGrowth(credential));
			} catch {}
			return result;
		} catch (error) {
			return {
				dispatched: false,
				reason: safeReason(error)
			};
		}
	};
	/**
	* Light up and collect every growth-center task for one account.
	*
	* The upstream moves a task only when activity events are reported, so
	* "earning" a task means: accept it, post the missing number of events, then
	* claim it. The whole sweep is deliberately sequential and spaced out —
	* reports sent faster than the upstream settles are accepted and counted
	* nowhere, which looks exactly like success and is the failure this guards
	* against.
	*
	* Never throws: a per-task failure is recorded and the sweep moves on, because
	* one unclaimable task must not cost the user the credits from the others.
	*/
	const runGrowthTasks = async (accountId, credential) => {
		const uid = credential.uid;
		let tasks;
		try {
			tasks = await fetchGrowthTasks(credential);
		} catch (error) {
			return {
				claimed: 0,
				outstanding: 0,
				reason: safeReason(error)
			};
		}
		if (tasks.length === 0) return {
			claimed: 0,
			outstanding: 0,
			reason: "growth task list is empty"
		};
		const unaccepted = tasks.filter((task) => task.status === "not_accepted" && !isSkippedGrowthTask(task.code)).map((task) => task.code);
		if (unaccepted.length > 0) try {
			await acceptGrowthTasks(credential, unaccepted);
			await delay(GROWTH_SETTLE_MS);
			tasks = await fetchGrowthTasks(credential);
		} catch {}
		let claimed = 0;
		let outstanding = 0;
		for (const task of tasks) {
			if (isSkippedGrowthTask(task.code) || task.status === "claimed") continue;
			const spec = growthTaskSpec(task.code);
			if (spec === void 0) continue;
			if (task.rewardCredit <= 0) continue;
			if (GROWTH_NIGHT_KINDS.has(spec.kind) && !inGrowthNightWindow()) {
				outstanding += 1;
				continue;
			}
			outstanding += 1;
			const need = Math.max(0, task.target - task.current);
			for (let index = task.current; index < task.target; index += 1) {
				try {
					await reportGrowthEvents(credential, [buildGrowthEvent(uid, spec.kind, index)]);
				} catch {
					break;
				}
				if (index + 1 < task.target) await delay(GROWTH_REPORT_GAP_MS);
			}
			if (need > 0) await delay(GROWTH_SETTLE_MS);
			try {
				const result = await claimGrowthTask(credential, task.code);
				if (result.ok) {
					outstanding -= 1;
					if (result.credit !== void 0) claimed += result.credit;
				}
			} catch {}
		}
		if (claimed > 0) refreshCredits();
		taskStates.set(accountId, { outstanding });
		return {
			claimed,
			outstanding
		};
	};
	/**
	* Run one task sweep at a time per account.
	*
	* The sweep takes tens of seconds by design (spaced reports), and both the
	* button and the five-minute timer can ask for it. Overlapping sweeps would
	* double-report events and race the claim, so the second caller joins the
	* first rather than starting its own.
	*/
	const growthTaskRuns = /* @__PURE__ */ new Map();
	const sweepGrowthTasks = (accountId) => {
		const running = growthTaskRuns.get(accountId);
		if (running !== void 0) return running;
		const run = (async () => {
			try {
				const credential = await cnStore.resolveFor(accountId);
				return await runGrowthTasks(accountId, credential);
			} catch (error) {
				return {
					claimed: 0,
					outstanding: 0,
					reason: safeReason(error)
				};
			} finally {
				growthTaskRuns.delete(accountId);
			}
		})();
		growthTaskRuns.set(accountId, run);
		return run;
	};
	/** True once today's check-in is in and the buddy has nothing left to do. */
	const growthFinished = (growth) => growth !== void 0 && growth.state === "idle" && growth.dailyLimitReached === true;
	/**
	* The card's one button: everything today's credits are owed for.
	*
	* The check-in and the trip are awaited because they answer fast and their
	* outcome is what the card reports back. The task sweep is not: filling five
	* progress bars takes tens of seconds of spaced reports, and holding an HTTP
	* response open for that is how a click turns into a timeout. It runs on the
	* side and the card's poll picks the result up.
	*/
	const checkinAndGrow = async (accountId) => {
		const result = await doCheckin(accountId);
		let total = (await runGrowth(accountId)).claimed ?? 0;
		const swept = await Promise.race([sweepGrowthTasks(accountId), delay(CHECKIN_SWEEP_WAIT_MS).then(() => void 0)]);
		if (swept !== void 0) total += swept.claimed;
		return total > 0 ? {
			...result,
			claimed: total
		} : result;
	};
	/**
	* Read-only poll so the card can show today's credit and trip state even when
	* auto check-in is off. Two GETs per account every five minutes is cheap; running this
	* unconditionally is what makes "今日尚未获得积分" correct instead of blank.
	*/
	const refreshCheckinStates = async () => {
		for (const account of await cnStore.accounts()) {
			try {
				const credential = await cnStore.resolveFor(account.id);
				checkinStates.set(account.id, await client.fetchCheckinStatus(credential));
			} catch {}
			try {
				const credential = await cnStore.resolveFor(account.id);
				growthStates.set(account.id, await readGrowth(credential));
			} catch {}
		}
	};
	/**
	* The daily sweep behind "自动签到".
	*
	* Runs every tick and decides per account, rather than once per day for all of
	* them: the buddy comes back *hours* after the click that sent it out, and a
	* once-a-day guard would leave that credit uncollected until tomorrow — which
	* is exactly the bug this replaces. An account is marked finished only once
	* its check-in landed, the buddy is home for the day, and every task has been
	* accepted and claimed, so an unfinished day keeps retrying.
	*
	* ponytail: an account whose tasks never move (a code the upstream no longer
	* credits, say) is retried on every five-minute tick. Each retry is a few
	* cheap GETs, so this is left alone; add a per-account sweep cap per day if
	* the upstream starts metering read traffic.
	*/
	const runAutoCheckin = async () => {
		if (!autoCheckin()) return;
		const day = today();
		for (const account of await cnStore.accounts()) {
			if (!account.checkinEnabled) continue;
			if (autoCheckinDone.get(account.id) === day) continue;
			await doCheckin(account.id);
			await runGrowth(account.id);
			const swept = await sweepGrowthTasks(account.id);
			if (checkinStates.get(account.id)?.todayCheckedIn === true && growthFinished(growthStates.get(account.id)) && swept.outstanding === 0 && swept.reason === void 0) autoCheckinDone.set(account.id, day);
		}
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyStatusRoute(webCtx, {
			store,
			client,
			catalog,
			regions: {
				global: {
					region: "global",
					store,
					client,
					catalog,
					probe: () => probeSection()
				},
				cn: {
					region: "cn",
					store: cnStore,
					client,
					catalog: cnCatalog
				}
			},
			refreshPolicy,
			autoCheckin,
			probe: () => probeSection(),
			controlKey,
			allowedHosts: () => current().allowedHosts ?? [],
			checkinStates,
			growthStates,
			taskStates
		});
		const applyModelSwitches = (models, enabled, region) => applyModelSwitchWrite(catalogFor(region ?? "global"), models, enabled, (ids) => persistConfigPatch(region === "cn" ? { cnDisabledModels: [...ids] } : { disabledModels: [...ids] }), refreshModels);
		registerWorkBuddyControlRoute(webCtx, {
			probe: async (modelId) => {
				const result = await probeService.probe(modelId, true);
				if (result.state === "ok") refreshModels();
				return result;
			},
			clearProbe: () => {
				probeStore.clear();
				refreshModels();
			},
			setScope: (scope, region) => {
				(region === void 0 ? catalog : catalogFor(region)).setScope(scope);
				persistConfigPatch(region === "cn" ? { cnModelScope: scope } : { modelScope: scope });
				refreshModels();
			},
			loginStart: async (region) => oauthFor(region ?? "global").start(),
			loginPoll: async (region) => {
				const actual = region ?? "global";
				const login = oauthFor(actual);
				const target = storeFor(actual);
				const targetCatalog = catalogFor(actual);
				const result = await login.poll();
				if ("pending" in result) return { pending: true };
				await target.importCredential(result.auth);
				syncProviderRows();
				try {
					targetCatalog.setUpstream(await client.fetchModels(result.auth));
				} catch {}
				refreshModels();
				refreshCredits();
				if (actual === "cn") {
					autoCheckinDone.clear();
					await runAutoCheckin();
				}
				return { done: true };
			},
			logout: async (region) => {
				const actual = region ?? "global";
				oauthFor(actual).cancel();
				await storeFor(actual).logout();
				syncProviderRows();
				refreshModels();
			},
			selectAccount: async (region, accountId) => {
				await storeFor(region).select(accountId);
				try {
					const credential = await storeFor(region).resolveFor(accountId);
					catalogFor(region).setUpstream(await client.fetchModels(credential));
				} catch {}
				refreshModels();
				refreshCredits();
			},
			removeAccount: async (region, accountId) => {
				const target = storeFor(region);
				await target.removeAccount(accountId);
				syncProviderRows();
				try {
					const credential = await target.resolve();
					catalogFor(region).setUpstream(await client.fetchModels(credential));
				} catch {}
				refreshModels();
				refreshCredits();
			},
			setAccountNote: async (region, accountId, note) => {
				return await storeFor(region).setNote(accountId, note);
			},
			setCheckinEnabled: async (accountId, enabled) => {
				await cnStore.setCheckinEnabled(accountId, enabled);
				if (enabled) {
					refreshCredits();
					autoCheckinDone.delete(accountId);
					await runAutoCheckin();
				}
			},
			checkin: checkinAndGrow,
			setRefreshPolicy: async (activeMinutes, inactiveMinutes) => {
				await persistConfigPatch({
					refreshActiveMinutes: activeMinutes,
					refreshInactiveMinutes: inactiveMinutes
				});
			},
			setAutoCheckin: async (enabled) => {
				await persistConfigPatch({ autoCheckin: enabled });
				if (!enabled) return;
				autoCheckinDone.clear();
				runAutoCheckin();
			},
			setModelEnabled: async (model, enabled, region) => {
				await applyModelSwitches([model], enabled, region);
			},
			setModelsEnabled: async (models, enabled, region) => {
				await applyModelSwitches(models, enabled, region);
			},
			connectivity: async (region, accountId) => {
				try {
					const target = storeFor(region);
					const credential = accountId === void 0 ? await target.resolve() : await target.resolveFor(accountId);
					await client.testConnectivity(credential);
					return { state: "ok" };
				} catch (error) {
					return {
						state: "error",
						reason: safeReason(error)
					};
				}
			},
			allowedHosts: () => current().allowedHosts ?? []
		}, controlKey);
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const settings = settingsCtx.settings;
		if (typeof settings.register !== "function") {
			ctx.logger.info("dsh-workbuddy: settings service has no register(); the card persists to its own file");
			return;
		}
		const scope = settings.register(WORKBUDDY_SETTINGS_NS, Config, { base: config });
		base = () => scope.get();
		const apply = () => {
			const next = current();
			store.setDesktopPath(next.authFile);
			cnStore.setDesktopPath(next.cnAuthFile);
			catalog.setScope(next.modelScope ?? "free");
			cnCatalog.setScope(next.cnModelScope ?? next.modelScope ?? "free");
			catalog.setDisabled(next.disabledModels ?? []);
			cnCatalog.setDisabled(next.cnDisabledModels ?? []);
			refreshModels();
			refreshCredits();
			refreshCheckinStates();
			runAutoCheckin();
		};
		apply();
		ctx.effect(() => scope.watch(() => {
			const fromSection = sanitizeSavedConfig(scope.get());
			const filled = saved;
			for (const [key, value] of Object.entries(fromSection)) if (!(key in filled)) filled[key] = value;
			apply();
		}), "dsh-workbuddy: settings observer");
	});
	let stopped = false;
	const backgroundTimer = setInterval(() => {
		refreshCredits();
		runAutoCheckin();
		refreshCheckinStates();
	}, 3e5);
	refreshCredits();
	refreshCheckinStates();
	runAutoCheckin();
	ctx.effect(() => () => {
		stopped = true;
		clearInterval(backgroundTimer);
		oauth.cancel();
		cnOauth.cancel();
		shim.close();
		cnShim.close();
		clearHostHeartbeat();
	});
	Promise.all([shim.ready, cnShim.ready]).then(() => {
		if (stopped) return;
		let invalidateGlobal;
		let invalidateCn;
		try {
			const globalAdapter = createWorkBuddyAdapter({
				shim,
				store,
				catalog,
				provider: WORKBUDDY_PROVIDER,
				displayName: WORKBUDDY_DISPLAY_NAME,
				resolveAttachments: () => ctx.get("attachments"),
				observe: (modelId) => probeService.recordFor(modelId)
			});
			const cnAdapter = createWorkBuddyAdapter({
				shim: cnShim,
				store: cnStore,
				catalog: cnCatalog,
				provider: WORKBUDDY_CN_PROVIDER,
				displayName: WORKBUDDY_CN_DISPLAY_NAME,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidateGlobal = globalAdapter.invalidate;
			invalidateCn = cnAdapter.invalidate;
			refreshModels = () => {
				if (stopped) return;
				invalidateGlobal?.();
				invalidateCn?.();
				ctx.emit("llm/adapters-updated");
			};
			rows = createProviderRows(ctx.llm, /* @__PURE__ */ new Map([["global", {
				provider: WORKBUDDY_PROVIDER,
				displayName: WORKBUDDY_DISPLAY_NAME,
				settingsNs: WORKBUDDY_SETTINGS_NS,
				adapter: globalAdapter.adapter
			}], ["cn", {
				provider: WORKBUDDY_CN_PROVIDER,
				displayName: WORKBUDDY_CN_DISPLAY_NAME,
				settingsNs: WORKBUDDY_SETTINGS_NS,
				adapter: cnAdapter.adapter
			}]]));
			try {
				ctx.effect(() => () => rows?.releaseAll());
			} catch {
				rows.releaseAll();
			}
			syncProviderRows();
			writeHostHeartbeat();
		} catch (error) {
			ctx.logger.error("dsh-workbuddy: provider registration failed", error);
			return;
		}
		(async () => {
			for (const [targetStore, targetClient, targetCatalog] of [[
				store,
				client,
				catalog
			], [
				cnStore,
				client,
				cnCatalog
			]]) try {
				const credential = await targetStore.current();
				if (credential === void 0 || stopped) continue;
				const models = await targetClient.fetchModels(credential);
				if (stopped) return;
				targetCatalog.setUpstream(models);
			} catch (error) {
				ctx.logger.warn("dsh-workbuddy: dynamic model catalog unavailable; serving the static fallback list", error);
			}
			invalidateGlobal?.();
			invalidateCn?.();
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-workbuddy: loopback endpoint failed to start; provider not registered", error);
	});
}
//#endregion
export { Config, LOGIN_TIMEOUT_MS, PROBE_EFFORT_CANDIDATES, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CN_AUTH_FILENAME, WORKBUDDY_CN_AUTH_FILE_ENV, WORKBUDDY_CN_DESKTOP_AUTH_BASENAME, WORKBUDDY_CN_DISPLAY_NAME, WORKBUDDY_CN_PROVIDER, WORKBUDDY_CONTROL_PATH, WORKBUDDY_DESKTOP_AUTH_BASENAME, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STATUS_PATH, WorkBuddyAccountStore, WorkBuddyCatalog, WorkBuddyCredentialStore, WorkBuddyOAuthLogin, WorkBuddyProbeService, WorkBuddyProbeStore, WorkBuddyUpstreamClient, apply, classifyUpstreamError, clearHostHeartbeat, composeCatalog, createWorkBuddyAdapter, createWorkBuddyShim, credentialFromPluginToken, defaultDesktopAuthCandidates, defaultDesktopAuthPath, fetchGrowthRewardToday, fetchGrowthStatus, fingerprintModel, inject, isFreeCredits, isHeartbeatProcessAlive, name, normalizeCredits, parseWorkBuddyAuth, prepareChatBody, probeModel, processStartTimeMs, randomSentinel, readHostHeartbeat, reasoningFields, regionOf, runGrowthTrip, workBuddyHostHeartbeatPath, workBuddyOwnAuthPath, workBuddyProbePath, workBuddyRegionOwnAuthPath };
