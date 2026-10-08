window.__ModuleLoader__.load({
	id: "dsh-workbuddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/display.ts
		/**
		* Node-free helpers shared by the Host and browser halves.
		*
		* @module dsh-workbuddy/display
		*/
		/**
		* Format an epoch millisecond timestamp the way the WorkBuddy app writes
		* package dates: Beijing wall clock, `YYYY/MM/DD HH:mm:ss`, zero padded, no
		* locale, no AM/PM.
		*
		* It lives here, not in the card, for two reasons: the card cannot be imported
		* by a test (it pulls `@deepseek-ai/dsh-client-ui-primitives`, which resolves
		* only inside DSH), and the offset is a *formatting* choice on top of the
		* parsing choice `parseUpstreamExpiry` already made - same +08:00 the upstream
		* writes its wall clock in.
		*/
		function formatExpiry(value) {
			if (value === void 0) return "";
			const date = new Date(value + 288e5);
			if (Number.isNaN(date.getTime())) return String(value);
			const pad = (part) => String(part).padStart(2, "0");
			return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
		}
		/**
		* Days left before a package expires, rounded up so anything still in the
		* future reads as at least one day.
		*
		* `Math.ceil`, not `round` or `floor`: a pack expiring in six hours is "1 day",
		* not "0 days" — rounding would print a package that is still usable as already
		* gone. Zero and below mean expired.
		*/
		function daysUntilExpiry(expiresAt, now = Date.now()) {
			const days = Math.ceil((expiresAt - now) / 864e5);
			return days === 0 ? 0 : days;
		}
		/**
		* `HH:MM:SS` left on a trip, clamped at zero.
		*
		* `Math.floor`, not `ceil`: a countdown that reads `00:00:01` while the buddy is
		* already home would be a lie in the other direction. Hours are not wrapped at
		* 24 — a trip longer than a day should read `26:00:00`, not `02:00:00`.
		*/
		function formatCountdown(remainingMs) {
			const total = Math.max(0, Math.floor(remainingMs / 1e3));
			const pad = (part) => String(part).padStart(2, "0");
			return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`;
		}
		/**
		* Whether the manual check-in button should be dimmed for today.
		*
		* Today's check-in being done is *not* enough on its own: this one click also
		* sends the buddy on its trip and sweeps the growth-center tasks, so a finished
		* check-in alongside anything still claimable must keep the button live. Only
		* when all three are spent is there nothing left to press it for.
		*
		* `tasks` is optional so the two-argument callers (and the older tests) keep
		* their meaning: with no sweep recorded, the task half cannot gate the button.
		*/
		function checkinExhausted(checkin, growth, tasks) {
			if (checkin?.todayCheckedIn !== true) return false;
			if (tasks?.outstanding !== void 0 && tasks.outstanding > 0) return false;
			if (growth === void 0) return true;
			if (growth.state === "arrived") return false;
			return !(growth.state === "idle" && growth.dailyLimitReached !== true);
		}
		function classifyCheckin(result) {
			if (!result.ok) return result.error === void 0 ? { kind: "failed" } : {
				kind: "failed",
				reason: result.error
			};
			const state = result.checkin?.state;
			if (state === "error") return result.checkin?.reason === void 0 ? { kind: "failed" } : {
				kind: "failed",
				reason: result.checkin.reason
			};
			const claimed = result.checkin?.claimed;
			return {
				kind: state === "already-checked-in" ? "already" : "done",
				...claimed === void 0 ? {} : { claimed }
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
		/** Header carrying the per-process key on control requests. */
		const WORKBUDDY_CONTROL_KEY_HEADER = "x-workbuddy-control-key";
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
		//#region src/client/WorkBuddyPluginCard.tsx
		/**
		* WorkBuddy status and policy card, contributed to Harness Plugin
		* configuration.
		*
		* The card is the plugin's only interactive surface. It reports the account and
		* remaining credit, starts browser OAuth, and owns the two decisions a user
		* actually makes here: which models the picker may show (the free-only filter),
		* and whether reasoning effort may be probed.
		*
		* Every action goes through the host's control route, which re-validates the
		* loopback origin and the in-process key. The card holds no credential and
		* cannot reach the upstream directly.
		*
		* @module dsh-workbuddy/client/WorkBuddyPluginCard
		*/
		/** How often the card re-reads the status document while it is open. */
		const POLL_INTERVAL_MS = 6e4;
		/** How often the card polls an in-flight browser login. */
		const LOGIN_POLL_INTERVAL_MS = 2e3;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "none",
			color: "var(--dsw-alias-label-tertiary)",
			transition: "transform 160ms ease"
		};
		/**
		* Official DSH settings-card chevron (`IconChevronDownOutline14`).
		*
		* Inlined so the plugin card does not depend on `dsh-client-ui-primitives`
		* being in the ModuleLoader table. The path is the same 14×14 glyph the
		* built-in PluginCard uses.
		*/
		function ChevronDownOutline14(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				"aria-hidden": "true",
				style: {
					...chevronStyle,
					transform: props.open ? "rotate(180deg)" : "none"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
					fill: "currentColor"
				})
			});
		}
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		/** The manual check-in sits inline beside 自动签到, so it is deliberately small. */
		const checkinButtonStyle = {
			...buttonStyle,
			minHeight: 26,
			padding: "2px 10px",
			fontSize: 12,
			borderRadius: 13
		};
		/** Sits beside the model search field, so it matches that field's height exactly. */
		const toolbarButtonStyle = {
			...buttonStyle,
			minHeight: 30,
			padding: "3px 12px",
			fontSize: 13,
			borderRadius: 6,
			whiteSpace: "nowrap"
		};
		const formControlStyle = {
			accentColor: "var(--dsw-alias-brand-primary, #4b8cff)",
			colorScheme: "dark"
		};
		const numberInputStyle = {
			...formControlStyle,
			boxSizing: "border-box",
			width: 70,
			minHeight: 30,
			padding: "3px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			appearance: "textfield"
		};
		const radioInputStyle = {
			...formControlStyle,
			flex: "none",
			width: 18,
			height: 18,
			margin: "2px 0 0",
			border: "2px solid var(--dsw-alias-border-l2)",
			borderRadius: "50%",
			background: "transparent",
			appearance: "none",
			cursor: "pointer"
		};
		const accountItemStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: 10,
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		/** The account in use answers "which one am I on?" with an outline, not a chip alone. */
		const accountItemSelectedStyle = {
			borderColor: "var(--dsw-alias-brand-primary)",
			boxShadow: "inset 0 0 0 1px var(--dsw-alias-brand-primary)"
		};
		const accountMetaStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** A package inside the warning window. Tertiary weight first, not bright. */
		const expiringSoonStyle = {
			fontSize: 12,
			lineHeight: "18px",
			fontWeight: 500,
			color: "var(--dsw-alias-state-warn-primary, #d19100)"
		};
		/** Last day or already gone. Loud enough to notice while scrolling the card. */
		const expiringVerySoonStyle = {
			fontSize: 12,
			lineHeight: "18px",
			fontWeight: 600,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const noteEditorStyle = {
			display: "flex",
			alignItems: "center",
			flexWrap: "wrap",
			gap: 8
		};
		const noteInputStyle = {
			...numberInputStyle,
			flex: "1 1 180px",
			width: 180,
			minWidth: 0
		};
		const connectivityStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary)"
		};
		/** Left half of the account's action row: the buddy line and today's credit, stacked. */
		const accountTextStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			minWidth: 0,
			flex: "1 1 auto"
		};
		/** Right half: 立即签到 and 自动签到 share the text's baseline instead of owning a row. */
		const accountActionsStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "flex-end",
			gap: 8,
			flexWrap: "wrap",
			marginLeft: "auto"
		};
		/** Holds the two halves; `flex-end` keeps the buttons in the card's bottom-right corner. */
		const accountRowStyle = {
			display: "flex",
			alignItems: "flex-end",
			justifyContent: "space-between",
			gap: 12,
			flexWrap: "wrap",
			width: "100%"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const sectionStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			paddingTop: 16
		};
		const sectionTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			padding: "6px 0"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		const mutedChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)"
		};
		const SCOPE_OPTIONS = [{
			scope: "free",
			labelKey: "scopeFree",
			hintKey: "scopeFreeHint"
		}, {
			scope: "all",
			labelKey: "scopeAll",
			hintKey: "scopeAllHint"
		}];
		/** Format a credit count without a locale dependency the card cannot assume. */
		function formatCount(value) {
			return value.toLocaleString();
		}
		/** Format an epoch millisecond timestamp for display, degrading to a raw value. */
		function formatTime(value) {
			if (value === void 0) return "";
			try {
				return new Date(value).toLocaleString();
			} catch {
				return String(value);
			}
		}
		/** Format a context window as a compact token count (`1M`, `192K`). */
		function formatContext(tokens) {
			if (tokens >= 1e6) return `${Math.round(tokens / 1e5) / 10}M`;
			if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}K`;
			return String(tokens);
		}
		/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("freeModel");
			return badge;
		}
		/** One line describing where the buddy is, or that today's trip is used up. */
		function growthLabel(growth, t) {
			const place = growth.locationName;
			if (growth.state === "arrived") return place === void 0 ? t("growthArrivedNoPlace") : t("growthArrived", { location: place });
			if (growth.state === "traveling") return place === void 0 ? t("growthTravelingNoPlace") : t("growthTraveling", { location: place });
			if (growth.dailyLimitReached !== true) return "";
			return growth.claimedToday === void 0 ? t("growthDoneToday") : t("growthDoneTodayClaimed", { credits: growth.claimedToday });
		}
		/**
		* The buddy's line: where it is, plus the live `旅行倒计时 HH:MM:SS` while it is
		* still travelling.
		*
		* The countdown ticks on its own one-second timer rather than off the status
		* document: the document is only re-read once a minute (and every five minutes
		* host-side), so a countdown driven by it would jump. Nothing is fetched — this
		* is arithmetic on `arriveAt`, which the host already sent.
		*
		* The countdown is part of the same span, not a second line: "正在前往咖啡馆"
		* and its remaining time are one statement about one trip. It is dropped once
		* the time is up, so an arrived buddy never shows a stale `00:00:00`; the host
		* poll swaps the label to "已从…回来" at its own pace.
		*/
		function GrowthLine({ growth, t }) {
			const arriveAt = growth.arriveAt;
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const remaining = arriveAt === void 0 ? 0 : arriveAt - now;
			const running = growth.state === "traveling" && remaining > 0;
			(0, react.useEffect)(() => {
				if (!running) return;
				const timer = setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					clearInterval(timer);
				};
			}, [running]);
			const label = growthLabel(growth, t);
			if (label === "" && !running) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: modelRateStyle,
				children: [label, running ? `${label === "" ? "" : " "}${t("growthCountdown", { time: formatCountdown(remaining) })}` : ""]
			});
		}
		/**
		* POST one control action with the in-process key.
		*
		* The key travels in a header rather than the body so it never lands in a log
		* line that records payloads, and the request carries no credential of its own.
		*/
		async function postControl(key, body) {
			try {
				const response = await fetch(WORKBUDDY_CONTROL_PATH, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						[WORKBUDDY_CONTROL_KEY_HEADER]: key
					},
					body: JSON.stringify(body)
				});
				if (!response.ok) return {
					ok: false,
					error: (await response.text().catch(() => "")).slice(0, 200) || `HTTP ${response.status}`
				};
				const payload = await response.json().catch(() => void 0);
				if (payload !== void 0 && payload.state !== void 0 && payload.state !== "ok" && payload.state !== "cleared") return {
					ok: false,
					error: payload.reason ?? payload.state
				};
				const checkin = payload?.checkin;
				return {
					ok: true,
					...typeof payload?.authUrl === "string" && payload.authUrl !== "" ? { authUrl: payload.authUrl } : {},
					...payload !== void 0 && "note" in payload ? { note: typeof payload.note === "string" ? payload.note : null } : {},
					...checkin === void 0 || typeof checkin.state !== "string" ? {} : { checkin: {
						state: checkin.state,
						...typeof checkin.reason === "string" ? { reason: checkin.reason } : {},
						...typeof checkin.claimed === "number" ? { claimed: checkin.claimed } : {}
					} },
					pending: payload?.pending === true
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** One model row: name, badges, and why it is or is not selectable. */
		function ModelRow(props) {
			const { model, t, disabled, onToggle } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: modelRowStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						minWidth: 0,
						flexDirection: "column",
						gap: 2
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 14,
							color: "var(--dsw-alias-label-primary)"
						},
						children: model.name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelRateStyle,
						children: [model.credits === void 0 ? model.id : t("rate", { rate: model.credits }), model.contextWindow === void 0 ? "" : ` · ${t("contextWindow", { tokens: formatContext(model.contextWindow) })}`]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: modelBadgeStyle,
					children: [
						(model.badges ?? []).map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)),
						model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chipStyle,
							children: t("freeModel")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedChipStyle,
							children: t("scopePaid")
						}),
						model.selectable === true ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedChipStyle,
							children: t("scopeHidden")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: model.selectable === true && model.enabled !== false,
							label: t("modelEnabled"),
							disabled: disabled || model.selectable !== true,
							onChange: onToggle
						})
					]
				})]
			});
		}
		/**
		* The plugin card.
		*
		* Everything it renders comes from one status document; the control route is
		* used only to change state, and a successful change triggers a re-read so the
		* card never shows an optimistic value the host did not accept.
		*/
		function WorkBuddyPluginCard(props) {
			const t = props.t ?? ((key) => key);
			const fixedRegion = props.region;
			const [open, setOpen] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("status");
			const [status, setStatus] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [waitingLogin, setWaitingLogin] = (0, react.useState)(false);
			const [loginRegion, setLoginRegion] = (0, react.useState)("global");
			const [authUrl, setAuthUrl] = (0, react.useState)(void 0);
			const [regionTab, setRegionTab] = (0, react.useState)("cn");
			const [removeAccountId, setRemoveAccountId] = (0, react.useState)(void 0);
			const [noteAccountId, setNoteAccountId] = (0, react.useState)(void 0);
			const [noteDraft, setNoteDraft] = (0, react.useState)("");
			const [connectivityFeedback, setConnectivityFeedback] = (0, react.useState)({});
			const [checkinFeedback, setCheckinFeedback] = (0, react.useState)({});
			const [modelQuery, setModelQuery] = (0, react.useState)("");
			const mounted = (0, react.useRef)(true);
			const load = (0, react.useCallback)(async () => {
				setLoading(true);
				try {
					const response = await fetch(WORKBUDDY_STATUS_PATH, { headers: { "Accept": "application/json" } });
					if (!response.ok) {
						setError(`${t("requestFailed")} (HTTP ${response.status})`);
						return;
					}
					const document = await response.json();
					if (!mounted.current) return;
					setStatus(document);
					setError(document.status === "error" ? document.message : void 0);
				} catch (cause) {
					if (!mounted.current) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setLoading(false);
				}
			}, [t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				load();
				const timer = setInterval(() => {
					load();
				}, POLL_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [load]);
			const regionRows = (0, react.useMemo)(() => status !== void 0 && status.status !== "error" ? status.regions ?? [] : [], [status]);
			const cardRegion = fixedRegion ?? (regionRows.find((region) => region.region === regionTab)?.signedIn === true ? regionTab : regionRows.find((region) => region.signedIn === true)?.region ?? regionTab);
			const activeRegion = regionRows.find((region) => region.region === cardRegion);
			const signedInStatus = status?.status === "signed-in" ? status : void 0;
			const signedIn = activeRegion?.signedIn === true;
			const controlKey = status !== void 0 && status.status !== "error" ? status.controlKey : void 0;
			const scope = signedIn ? activeRegion?.scope ?? "free" : "free";
			const probe = signedIn ? activeRegion?.probe : void 0;
			const models = signedIn ? activeRegion?.models ?? [] : [];
			const priceSource = activeRegion?.priceSource;
			const priceSourcePath = activeRegion?.priceSourcePath;
			const autoCheckinEnabled = cardRegion === "cn" ? activeRegion?.checkin?.enabled === true : signedInStatus?.autoCheckin === true;
			const visibleModels = (0, react.useMemo)(() => {
				const query = modelQuery.trim().toLowerCase();
				if (query === "") return models;
				return models.filter((model) => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query));
			}, [models, modelQuery]);
			const toggleable = (0, react.useMemo)(() => {
				const rows = visibleModels.filter((model) => model.selectable === true);
				return {
					ids: rows.map((model) => model.id),
					allOn: rows.length > 0 && rows.every((model) => model.enabled !== false)
				};
			}, [visibleModels]);
			/**
			* Run one control action, then re-read so the card reflects host state only.
			*
			* `applyPatch` turns a successful result into an optimistic document patch —
			* an action that already knows its outcome (a stored note, say) paints it
			* immediately, and the `load()` below then confirms it against host state.
			*/
			const runControl = (0, react.useCallback)(async (body, applyPatch) => {
				if (controlKey === void 0) return {
					ok: false,
					error: t("requestFailed")
				};
				setBusy(true);
				try {
					const result = await postControl(controlKey, body);
					if (!result.ok) {
						setError(result.error ?? t("requestFailed"));
						await load();
						return result;
					}
					setError(void 0);
					if (applyPatch !== void 0) setStatus((current) => current === void 0 ? current : applyPatch(result)(current));
					await load();
					return result;
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [
				controlKey,
				load,
				t
			]);
			/** Paint one account's stored note into the current document, or clear it when null. */
			const withAccountNote = (0, react.useCallback)((region, accountId, note) => (document) => {
				if (document.status !== "signed-in" || document.regions === void 0) return document;
				return {
					...document,
					regions: document.regions.map((item) => item.region === region ? {
						...item,
						accounts: item.accounts.map((account) => {
							if (account.id !== accountId) return account;
							const next = { ...account };
							if (note === null) delete next.note;
							else next.note = note;
							return next;
						})
					} : item)
				};
			}, []);
			const onConnect = (0, react.useCallback)(async (region = "global") => {
				if (controlKey === void 0) return;
				setBusy(true);
				setLoginRegion(region);
				try {
					const result = await postControl(controlKey, {
						action: "loginStart",
						region
					});
					if (!result.ok || result.authUrl === void 0) {
						setWaitingLogin(false);
						setError(result.error ?? t("loginFailed", { message: t("requestFailed") }));
						return;
					}
					setError(void 0);
					setAuthUrl(result.authUrl);
					setWaitingLogin(true);
					window.open(result.authUrl, "_blank", "noopener,noreferrer");
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [controlKey, t]);
			(0, react.useEffect)(() => {
				if (!waitingLogin || controlKey === void 0) return;
				const timer = setInterval(() => {
					(async () => {
						const result = await postControl(controlKey, {
							action: "loginPoll",
							region: loginRegion
						});
						if (!result.ok) {
							setWaitingLogin(false);
							setError(t("loginFailed", { message: result.error ?? t("requestFailed") }));
							return;
						}
						if (result.pending === true) return;
						setWaitingLogin(false);
						setAuthUrl(void 0);
						await load();
					})();
				}, LOGIN_POLL_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [
				waitingLogin,
				controlKey,
				load,
				loginRegion,
				t
			]);
			const onScope = (0, react.useCallback)((next) => {
				runControl({
					action: "setScope",
					scope: next,
					region: cardRegion
				});
			}, [runControl, cardRegion]);
			const onProbe = (0, react.useCallback)((model) => {
				runControl({
					action: "probe",
					model
				});
			}, [runControl]);
			const onModelToggle = (0, react.useCallback)((model, enabled) => {
				runControl({
					action: "setModelEnabled",
					model,
					enabled,
					region: cardRegion
				});
			}, [runControl, cardRegion]);
			const onModelsToggle = (0, react.useCallback)((list, enabled) => {
				if (list.length === 0) return;
				runControl({
					action: "setModelsEnabled",
					models: list,
					enabled,
					region: cardRegion
				});
			}, [runControl, cardRegion]);
			const onClearProbe = (0, react.useCallback)(() => {
				runControl({ action: "clearProbe" });
			}, [runControl]);
			const selectedAccount = activeRegion?.accounts.find((account) => account.selected);
			const credits = selectedAccount?.credits;
			const creditsError = selectedAccount?.creditsError;
			const accountRows = (0, react.useMemo)(() => credits?.accounts ?? [], [credits]);
			const activeAccounts = activeRegion?.accounts ?? [];
			const displayNickname = selectedAccount?.nickname;
			const displayExpiresAt = selectedAccount?.expiresAt;
			const onSelectAccount = (0, react.useCallback)((region, accountId) => {
				runControl({
					action: "selectAccount",
					region,
					accountId
				});
			}, [runControl]);
			const onConnectivity = (0, react.useCallback)((region, accountId) => {
				const targetId = accountId ?? (region === cardRegion ? activeRegion?.selectedAccountId : void 0);
				if (targetId === void 0) return;
				const key = `${region}:${targetId}`;
				setConnectivityFeedback((previous) => ({
					...previous,
					[key]: { state: "checking" }
				}));
				runControl({
					action: "connectivity",
					region,
					accountId: targetId
				}).then((result) => {
					if (!mounted.current) return;
					setConnectivityFeedback((previous) => ({
						...previous,
						[key]: result.ok ? {
							state: "ok",
							checkedAt: Date.now()
						} : {
							state: "error",
							message: result.error ?? t("requestFailed"),
							checkedAt: Date.now()
						}
					}));
				});
			}, [
				activeRegion?.selectedAccountId,
				cardRegion,
				runControl,
				t
			]);
			/**
			* One manual check-in (which also runs the growth trip, host-side).
			*
			* The card must say something the moment it is clicked, so it paints a
			* `running` row before the round trip and replaces it with the host's own
			* outcome — including the failure reason, which the route nests under an `ok`
			* envelope precisely so it survives this path.
			*/
			const onCheckin = (0, react.useCallback)((region, accountId) => {
				const key = `${region}:${accountId}`;
				setCheckinFeedback((previous) => ({
					...previous,
					[key]: { state: "running" }
				}));
				runControl({
					action: "checkin",
					accountId
				}).then((result) => {
					if (!mounted.current) return;
					const outcome = classifyCheckin(result);
					setCheckinFeedback((previous) => ({
						...previous,
						[key]: outcome.kind === "failed" ? {
							state: "error",
							message: outcome.reason ?? t("requestFailed")
						} : outcome.claimed === void 0 ? {
							state: "ok",
							message: outcome.kind === "already" ? t("alreadyCheckedIn") : t("checkinDone")
						} : {
							state: "ok",
							message: t("growthClaimed", { credits: outcome.claimed })
						}
					}));
				});
			}, [runControl, t]);
			const onRemoveAccount = (0, react.useCallback)((region, accountId) => {
				const key = `${region}:${accountId}`;
				if (removeAccountId !== key) {
					setRemoveAccountId(key);
					return;
				}
				setRemoveAccountId(void 0);
				runControl({
					action: "removeAccount",
					region,
					accountId
				});
			}, [removeAccountId, runControl]);
			const onSaveNote = (0, react.useCallback)((region, accountId) => {
				const key = `${region}:${accountId}`;
				const draft = noteDraft;
				setNoteAccountId(void 0);
				runControl({
					action: "setAccountNote",
					region,
					accountId,
					note: draft
				}, (result) => withAccountNote(region, accountId, result.note ?? null)).then((result) => {
					if (!mounted.current) return;
					if (result.ok) {
						setNoteDraft("");
						return;
					}
					setNoteAccountId(key);
					setNoteDraft(draft);
				});
			}, [
				noteDraft,
				runControl,
				withAccountNote
			]);
			const wasOpen = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!open || wasOpen.current || controlKey === void 0 || status === void 0 || !signedIn) return;
				wasOpen.current = true;
				const selected = activeRegion?.selectedAccountId;
				onConnectivity(cardRegion, selected);
			}, [
				activeRegion?.selectedAccountId,
				cardRegion,
				controlKey,
				onConnectivity,
				open,
				status
			]);
			(0, react.useEffect)(() => {
				if (!open) wasOpen.current = false;
			}, [open]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: fixedRegion === "cn" ? `${t("title")} · ${t("regionCn")}` : fixedRegion === "global" ? `${t("title")} · ${t("regionGlobal")}` : t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t("intro")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronDownOutline14, { open })]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						loading && status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: t("loading")
						}) : null,
						status !== void 0 && status.status !== "error" && !signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 10
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: rowStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: statusStyle,
										children: waitingLogin ? t("connecting") : t("signedOut")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											display: "flex",
											gap: 8
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											onClick: () => {
												load();
											},
											disabled: loading,
											children: loading ? t("refreshing") : t("refresh")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											onClick: () => {
												onConnect(cardRegion);
											},
											disabled: busy || waitingLogin || controlKey === void 0,
											children: t("connect")
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: t("signedOutHint")
								}),
								authUrl === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									href: authUrl,
									target: "_blank",
									rel: "noreferrer",
									style: {
										...buttonStyle,
										display: "inline-block",
										textDecoration: "none"
									},
									children: t("openLogin")
								})
							]
						}) : null,
						status !== void 0 && status.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null,
						signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column"
							},
							children: [
								fixedRegion !== void 0 || regionRows.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: tabBarStyle,
									role: "tablist",
									"aria-label": t("accountsHeading"),
									children: ["cn", "global"].map((region) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": cardRegion === region,
										style: cardRegion === region ? {
											...tabStyle,
											...tabActiveStyle
										} : tabStyle,
										onClick: () => {
											setRegionTab(region);
										},
										children: region === "global" ? t("regionGlobal") : t("regionCn")
									}, region))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: tabBarStyle,
									role: "tablist",
									children: ["status", "models"].map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": tab === key,
										style: tab === key ? {
											...tabStyle,
											...tabActiveStyle
										} : tabStyle,
										onClick: () => {
											setTab(key);
										},
										children: key === "status" ? t("tabStatus") : t("tabModels")
									}, key))
								}),
								tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: sectionStyle,
									children: [
										regionRows.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												flexDirection: "column",
												gap: 10
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														alignItems: "center",
														justifyContent: "space-between",
														gap: 12
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
														style: sectionTitleStyle,
														children: t("accountsHeading")
													}), signedIn && cardRegion === "cn" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: {
															display: "flex",
															alignItems: "center",
															gap: 8
														},
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: bodyStyle,
															children: t("autoCheckin")
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
															checked: autoCheckinEnabled,
															label: t("autoCheckin"),
															disabled: busy || controlKey === void 0,
															onChange: (enabled) => {
																runControl({
																	action: "setAutoCheckin",
																	enabled
																});
															}
														})]
													}) : null]
												}),
												activeAccounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: bodyStyle,
													children: t("noAccounts")
												}) : activeAccounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: account.selected ? {
														...accountItemStyle,
														...accountItemSelectedStyle
													} : accountItemStyle,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: rowStyle,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																style: statusStyle,
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.note ?? account.nickname ?? account.id }),
																	account.note !== void 0 && account.nickname !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		style: accountMetaStyle,
																		children: account.nickname
																	}) : null,
																	account.selected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		style: chipStyle,
																		children: t("selectedAccount")
																	}) : null,
																	account.domain === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		style: accountMetaStyle,
																		children: account.domain
																	})
																]
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																style: {
																	display: "flex",
																	gap: 8,
																	flexWrap: "wrap"
																},
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		style: buttonStyle,
																		disabled: busy || account.selected,
																		onClick: () => {
																			onSelectAccount(cardRegion, account.id);
																		},
																		children: t("useAccount")
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		style: buttonStyle,
																		disabled: busy,
																		onClick: () => {
																			setNoteAccountId(noteAccountId === `${cardRegion}:${account.id}` ? void 0 : `${cardRegion}:${account.id}`);
																			setNoteDraft(account.note ?? "");
																		},
																		children: t("editNote")
																	}),
																	activeAccounts.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		style: buttonStyle,
																		disabled: busy,
																		onClick: () => {
																			onRemoveAccount(cardRegion, account.id);
																		},
																		children: removeAccountId === `${cardRegion}:${account.id}` ? t("removeConfirm") : t("removeAccount")
																	}) : null,
																	removeAccountId === `${cardRegion}:${account.id}` ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		style: buttonStyle,
																		disabled: busy,
																		onClick: () => {
																			setRemoveAccountId(void 0);
																		},
																		children: t("removeCancel")
																	}) : null,
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		style: buttonStyle,
																		"aria-busy": connectivityFeedback[`${cardRegion}:${account.id}`]?.state === "checking",
																		disabled: busy,
																		onClick: () => {
																			onConnectivity(cardRegion, account.id);
																		},
																		children: connectivityFeedback[`${cardRegion}:${account.id}`]?.state === "checking" ? t("testingConnectivity") : t("testConnectivity")
																	})
																]
															})]
														}),
														noteAccountId === `${cardRegion}:${account.id}` ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: noteEditorStyle,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																	type: "text",
																	value: noteDraft,
																	maxLength: 80,
																	placeholder: account.nickname ?? account.id,
																	"aria-label": t("notePlaceholder"),
																	style: noteInputStyle,
																	disabled: busy,
																	onChange: (event) => {
																		setNoteDraft(event.currentTarget.value);
																	},
																	onKeyDown: (event) => {
																		if (event.key === "Enter" && !event.nativeEvent.isComposing) onSaveNote(cardRegion, account.id);
																	}
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																	type: "button",
																	style: buttonStyle,
																	disabled: busy,
																	onClick: () => {
																		onSaveNote(cardRegion, account.id);
																	},
																	children: t("saveNote")
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																	type: "button",
																	style: buttonStyle,
																	disabled: busy,
																	onClick: () => {
																		setNoteAccountId(void 0);
																	},
																	children: t("cancelNote")
																})
															]
														}) : null,
														account.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: modelRateStyle,
															children: t("creditsTotal", { total: formatCount(account.credits.total) })
														}),
														connectivityFeedback[`${cardRegion}:${account.id}`] === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															role: "status",
															"aria-live": "polite",
															style: {
																...connectivityStyle,
																color: connectivityFeedback[`${cardRegion}:${account.id}`].state === "error" ? "var(--dsw-alias-state-error-primary)" : connectivityFeedback[`${cardRegion}:${account.id}`].state === "ok" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)"
															},
															children: [connectivityFeedback[`${cardRegion}:${account.id}`].state === "checking" ? t("testingConnectivity") : connectivityFeedback[`${cardRegion}:${account.id}`].state === "ok" ? t("connectivityOk") : t("connectivityFailed", { message: connectivityFeedback[`${cardRegion}:${account.id}`].message ?? t("requestFailed") }), connectivityFeedback[`${cardRegion}:${account.id}`].checkedAt === void 0 ? "" : ` · ${t("connectivityCheckedAt", { time: formatTime(connectivityFeedback[`${cardRegion}:${account.id}`].checkedAt) })}`]
														}),
														cardRegion === "cn" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: accountRowStyle,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																style: accountTextStyle,
																children: [
																	checkinFeedback[`${cardRegion}:${account.id}`] === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		role: "status",
																		"aria-live": "polite",
																		style: {
																			...modelRateStyle,
																			color: checkinFeedback[`${cardRegion}:${account.id}`].state === "error" ? "var(--dsw-alias-state-error-primary)" : checkinFeedback[`${cardRegion}:${account.id}`].state === "ok" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)"
																		},
																		children: checkinFeedback[`${cardRegion}:${account.id}`].state === "running" ? t("checkingIn") : checkinFeedback[`${cardRegion}:${account.id}`].state === "error" ? t("checkinFailed", { message: checkinFeedback[`${cardRegion}:${account.id}`].message ?? t("requestFailed") }) : checkinFeedback[`${cardRegion}:${account.id}`].message ?? t("checkinDone")
																	}),
																	account.growth === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GrowthLine, {
																		growth: account.growth,
																		t
																	}),
																	account.checkin === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																		style: modelRateStyle,
																		children: [account.checkin.todayCheckedIn === true ? t("todayCreditEarned", { credit: formatCount(account.checkin.todayCredit ?? 0) }) : t("todayCreditPending"), account.checkin.streakDays === void 0 || account.checkin.streakDays <= 1 ? "" : ` · ${t("streakDays", { days: account.checkin.streakDays })}`]
																	})
																]
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																style: accountActionsStyle,
																children: [(() => {
																	const doneForToday = checkinExhausted(account.checkin, account.growth, account.tasks);
																	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		...doneForToday ? { title: t("checkinAlreadyDone") } : {},
																		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																			type: "button",
																			style: doneForToday ? {
																				...checkinButtonStyle,
																				opacity: .5,
																				cursor: "default"
																			} : checkinButtonStyle,
																			disabled: busy || controlKey === void 0 || doneForToday,
																			onClick: () => {
																				onCheckin(cardRegion, account.id);
																			},
																			children: t("checkinNow")
																		})
																	});
																})(), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	style: {
																		display: "flex",
																		alignItems: "center",
																		gap: 8,
																		fontSize: 13
																	},
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("checkinSelected") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
																		checked: autoCheckinEnabled && account.checkinEnabled === true,
																		label: t("checkinSelected"),
																		...autoCheckinEnabled ? {} : { title: t("checkinNeedsScript") },
																		disabled: busy || controlKey === void 0 || !autoCheckinEnabled,
																		onChange: (enabled) => {
																			runControl({
																				action: "setCheckinEnabled",
																				accountId: account.id,
																				enabled
																			});
																		}
																	})]
																})]
															})]
														}) : null
													]
												}, account.id)),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: rowStyle,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: buttonStyle,
														disabled: busy || controlKey === void 0,
														onClick: () => {
															onConnect(cardRegion);
														},
														children: t("addAccount")
													})
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: modelRateStyle,
													children: t("refreshPolicyHint")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: rowStyle,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														style: modelRateStyle,
														children: [
															t("activeRefresh"),
															" ",
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "number",
																min: 1,
																defaultValue: signedInStatus?.refreshPolicy?.activeMinutes ?? 15,
																onBlur: (event) => {
																	runControl({
																		action: "setRefreshPolicy",
																		activeMinutes: Number(event.currentTarget.value),
																		inactiveMinutes: signedInStatus?.refreshPolicy?.inactiveMinutes ?? 60
																	});
																},
																style: numberInputStyle
															})
														]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														style: modelRateStyle,
														children: [
															t("inactiveRefresh"),
															" ",
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "number",
																min: 1,
																defaultValue: signedInStatus?.refreshPolicy?.inactiveMinutes ?? 60,
																onBlur: (event) => {
																	runControl({
																		action: "setRefreshPolicy",
																		activeMinutes: signedInStatus?.refreshPolicy?.activeMinutes ?? 15,
																		inactiveMinutes: Number(event.currentTarget.value)
																	});
																},
																style: numberInputStyle
															})
														]
													})]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("accountHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: rowStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: statusStyle,
												children: displayNickname === void 0 ? t("signedInAs", { nickname: "—" }) : t("signedInAs", { nickname: displayNickname })
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													display: "flex",
													gap: 8
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: buttonStyle,
													onClick: () => {
														load();
													},
													disabled: loading,
													children: loading ? t("refreshing") : t("refresh")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: buttonStyle,
													onClick: () => {
														runControl({
															action: "logout",
															region: cardRegion
														});
													},
													disabled: busy,
													children: t("signOutAll")
												})]
											})]
										}),
										displayExpiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("accessTokenExpires", { time: formatTime(displayExpiresAt) })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("creditsHeading")
										}),
										creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: errorStyle,
											children: t("creditsError", { message: creditsError })
										}),
										credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: quotaGroupStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: bodyStyle,
												children: t("creditsTotal", { total: formatCount(credits.total) })
											}), accountRows.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: quotaGroupStyle,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: quotaLabelStyle,
													children: t("creditsDetailHeading")
												}), accountRows.map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 4
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: quotaLabelStyle,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															style: {
																display: "flex",
																alignItems: "baseline",
																gap: 12,
																flexWrap: "wrap"
															},
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.capacityType === 4 ? t("creditBucketPlan") : t("creditBucketBonus") }),
																account.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	style: accountMetaStyle,
																	children: t("creditPackageExpires", { time: formatExpiry(account.expiresAt) })
																}),
																account.expiresAt === void 0 ? null : (() => {
																	const days = daysUntilExpiry(account.expiresAt);
																	if (days > 7) return null;
																	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		style: days <= 0 ? expiringVerySoonStyle : expiringSoonStyle,
																		children: days <= 0 ? t("creditExpired") : t("creditExpiresInDays", { days })
																	});
																})()
															]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.size > 0 ? t("creditUsedOfSize", {
															used: formatCount(account.size - account.remain),
															size: formatCount(account.size)
														}) : t("creditPackageUnknownSize", { remain: formatCount(account.remain) }) })]
													}), account.size > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														style: progressTrackStyle,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
															width: `${Math.max(0, Math.min(100, Math.round(account.remain / account.size * 100)))}%`,
															height: "100%",
															background: "var(--dsw-alias-brand-primary)"
														} })
													}) : null]
												}, `${account.packageName}-${account.expiresAt ?? "none"}-${index}`))]
											})]
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: sectionStyle,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("scopeHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												display: "flex",
												flexDirection: "column",
												gap: 8
											},
											children: SCOPE_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													display: "flex",
													alignItems: "flex-start",
													gap: 10,
													padding: "8px 10px",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: 8,
													cursor: busy ? "default" : "pointer"
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "radio",
													name: "workbuddy-ai-model-scope",
													checked: scope === option.scope,
													disabled: busy || controlKey === void 0,
													onChange: () => {
														onScope(option.scope);
													},
													style: {
														...radioInputStyle,
														borderColor: scope === option.scope ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l2)",
														background: scope === option.scope ? "var(--dsw-alias-brand-primary)" : "transparent",
														boxShadow: scope === option.scope ? "inset 0 0 0 4px var(--dsw-alias-bg-layer-1)" : "none"
													}
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 2
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: {
															fontSize: 14,
															color: "var(--dsw-alias-label-primary)"
														},
														children: [t(option.labelKey), scope === option.scope ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																...mutedChipStyle,
																marginLeft: 8
															},
															children: t("scopeActive")
														}) : null]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: modelRateStyle,
														children: t(option.hintKey)
													})]
												})]
											}, option.scope))
										}),
										busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("scopeSaving")
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("modelsHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: t("modelsIntro")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: t("modelsSwitchHint")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: priceSource === "upstream" ? t("priceSourceUpstream") : priceSource === "builtin" ? t("priceSourceBuiltin") : t("priceSourceCache")
										}),
										priceSourcePath === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: t("priceSourcePath", { path: priceSourcePath })
										}),
										models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("modelsEmpty")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												alignItems: "center",
												gap: 8
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "search",
												value: modelQuery,
												placeholder: t("modelSearch"),
												onChange: (event) => {
													setModelQuery(event.target.value);
												},
												style: {
													...numberInputStyle,
													flex: "1 1 auto",
													width: "auto"
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: toolbarButtonStyle,
												disabled: busy || controlKey === void 0 || toggleable.ids.length === 0,
												onClick: () => {
													onModelsToggle(toggleable.ids, !toggleable.allOn);
												},
												children: toggleable.allOn ? t("modelsUnselectAll") : t("modelsSelectAll")
											})]
										}), visibleModels.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("modelsNoMatch")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											style: {
												margin: 0,
												padding: 0,
												listStyle: "none"
											},
											children: visibleModels.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
												model,
												t,
												disabled: busy || controlKey === void 0,
												onToggle: (enabled) => {
													onModelToggle(model.id, enabled);
												}
											}, model.id))
										})] }),
										probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												flexDirection: "column",
												gap: 8
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
													style: sectionTitleStyle,
													children: t("probeHeading")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: modelRateStyle,
													children: t("probeIntro")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: modelRateStyle,
													children: t("probeCandidates", { count: probe.candidates.length })
												}),
												probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: bodyStyle,
													children: t("probeResultEmpty")
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 6
													},
													children: probe.candidates.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: rowStyle,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: bodyStyle,
															children: id
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															style: buttonStyle,
															disabled: busy || probe.running,
															onClick: () => {
																onProbe(id);
															},
															children: probe.running ? t("probeRunning", { model: id }) : t("probeStart")
														})]
													}, id))
												}),
												probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 4
													},
													children: [probe.results.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: modelRateStyle,
														children: [result.validation === "validating" ? t("probeResultVerified", { levels: result.efforts.join(", ") || t("probeResultNoLevels") }) : result.validation === "non-validating" ? t("probeResultNotValidating") : t("probeResultUnknown"), ` · ${t("probeResultAt", { time: formatTime(result.probedAt) })}`]
													}, result.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: buttonStyle,
														disabled: busy,
														onClick: onClearProbe,
														children: t("probeClear")
													})]
												})
											]
										})
									]
								}),
								error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										...errorStyle,
										paddingTop: 12
									},
									children: error
								})
							]
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy, registered under the `settings.workbuddy-ai` locale namespace.
		*
		* @module dsh-workbuddy/client/locales
		*/
		const en = {
			nav: "WorkBuddy",
			title: "DSH WorkBuddy",
			intro: "Use WorkBuddy (domestic or international) models in DSH — sign in through the website; free models by default.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Click Connect to sign in through the WorkBuddy website. The desktop app is optional.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			connect: "Connect",
			addAccount: "Add account",
			signOutAll: "Sign out all accounts",
			removeAccount: "Remove",
			removeConfirm: "Remove this account?",
			removeCancel: "Keep account",
			editNote: "Edit name",
			saveNote: "Save name",
			cancelNote: "Cancel",
			notePlaceholder: "Account name",
			connecting: "Waiting for browser login…",
			openLogin: "Open login page",
			disconnect: "Disconnect",
			loginFailed: "Sign-in failed: {message}",
			requestFailed: "Request failed",
			regionGlobal: "International",
			regionCn: "Domestic",
			tabLabelGlobal: "WorkBuddy · International",
			tabLabelCn: "WorkBuddy · Domestic",
			accountsHeading: "Accounts",
			noAccounts: "No accounts yet — click Add account.",
			useAccount: "Switch to this account",
			selectedAccount: "Current",
			testConnectivity: "Test connectivity",
			testingConnectivity: "Testing…",
			connectivityOk: "Connection OK",
			connectivityFailed: "Connection failed: {message}",
			connectivityCheckedAt: "Checked {time}",
			autoCheckin: "Check-in script",
			checkinSelected: "Auto check-in",
			todayCreditEarned: "Earned {credit} today",
			todayCreditPending: "No credit yet today",
			streakDays: "{days}-day streak",
			growthTraveling: "Traveling to {location}",
			growthTravelingNoPlace: "Traveling",
			growthArrived: "Back from {location}",
			growthArrivedNoPlace: "Back",
			growthDoneToday: "Today's trip is done",
			growthDoneTodayClaimed: "Today's trip is done · {credits} credits earned",
			growthClaimed: "Claimed {credits} credits today",
			growthCountdown: "Trip returns in {time}",
			checkinNow: "Claim daily rewards",
			checkinAlreadyDone: "Already done for today — nothing left to claim",
			checkingIn: "Checking in…",
			checkinDone: "Checked in",
			alreadyCheckedIn: "Already checked in",
			checkinFailed: "Check-in failed: {message}",
			checkinUnsupported: "Not available internationally",
			activeRefresh: "Current account minutes",
			inactiveRefresh: "Other account minutes",
			refreshPolicyHint: "Only status and credit requests run in the background; model probes never do.",
			tabStatus: "Status",
			tabModels: "Models",
			accountHeading: "Account",
			creditsHeading: "Remaining credit",
			creditsTotal: "Remaining: {total}",
			creditsDetailHeading: "By type",
			creditUsedOfSize: "Used {used} / {size}",
			creditBucketPlan: "Plan credit",
			creditBucketBonus: "Bonus credit",
			creditPackageUnknownSize: "{remain} remaining",
			creditPackageExpires: "Expires {time}",
			creditExpiresInDays: "{days} days left",
			creditExpired: "Expired",
			checkinNeedsScript: "Turn on the check-in script first",
			creditsError: "Credit unavailable: {message}",
			scopeHeading: "Model scope",
			scopeFree: "Free models only",
			scopeFreeHint: "List only models the selected region marks x0.00. Nothing here can spend credit.",
			scopeAll: "All models",
			scopeAllHint: "Also list paid models. Selecting one spends real credit at the rate shown next to its name.",
			scopeSaving: "Applying…",
			scopeFailed: "Could not change the model scope: {message}",
			scopeActive: "Active",
			scopePaid: "Paid",
			scopeHidden: "Hidden by the free-only filter",
			modelsHeading: "Models",
			modelsIntro: "Rates come from the selected region’s WorkBuddy catalog; domestic and international prices are independent.",
			modelsSwitchHint: "Switches control the model picker list only; an already-selected model keeps working. New models show by default.",
			modelEnabled: "List in the model picker",
			modelsEmpty: "No models are available right now.",
			modelSearch: "Search models",
			modelsSelectAll: "Select all",
			modelsUnselectAll: "Unselect all",
			modelsNoMatch: "No model matches the search.",
			freeModel: "Free",
			rate: "{rate} credits per message",
			contextWindow: "Context {tokens}",
			priceSourceCache: "Prices read from the WorkBuddy app cache",
			priceSourceUpstream: "Prices from the selected region’s live model catalog",
			priceSourceBuiltin: "Prices from the plugin’s built-in free list (the app cache was not readable)",
			priceSourcePath: "Source: {path}",
			probeHeading: "Reasoning effort detection",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsent: "Authorize detection",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeLabel: "Reasoning levels",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeResultNoLevels: "No tested levels were accepted.",
			probeFailed: "Detection failed: {message}"
		};
		const zh = {
			nav: "WorkBuddy",
			title: "DSH WorkBuddy",
			intro: "在 DSH 中使用 WorkBuddy（国内版/国际版）模型，通过网站登录，默认只列出免费模型。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "点击「连接」通过 WorkBuddy 网站登录。桌面 App 不是必须的。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			refresh: "刷新",
			refreshing: "正在刷新…",
			connect: "连接",
			addAccount: "添加账号",
			signOutAll: "退出全部账号",
			removeAccount: "移除",
			removeConfirm: "确认移除？",
			removeCancel: "保留账号",
			editNote: "编辑名称",
			saveNote: "保存名称",
			cancelNote: "取消",
			notePlaceholder: "账户名称",
			connecting: "正在等待浏览器登录…",
			openLogin: "打开登录页",
			disconnect: "断开",
			loginFailed: "登录失败：{message}",
			requestFailed: "请求失败",
			regionGlobal: "国际版",
			regionCn: "国内版",
			tabLabelGlobal: "WorkBuddy · 国际",
			tabLabelCn: "WorkBuddy · 国内",
			accountsHeading: "账号",
			noAccounts: "暂无账号，请点击「添加账号」。",
			useAccount: "切换到此账号",
			selectedAccount: "当前使用",
			testConnectivity: "测试连通性",
			testingConnectivity: "正在测试…",
			connectivityOk: "连接正常",
			connectivityFailed: "连接失败：{message}",
			connectivityCheckedAt: "已检测 {time}",
			autoCheckin: "开启签到脚本",
			checkinSelected: "自动签到",
			todayCreditEarned: "今日已获得 {credit} 积分",
			todayCreditPending: "今日尚未获得积分",
			streakDays: "连续签到 {days} 天",
			growthTraveling: "正在前往{location}",
			growthTravelingNoPlace: "旅行中",
			growthArrived: "已从{location}回来",
			growthArrivedNoPlace: "旅行归来",
			growthDoneToday: "今日旅行已完成",
			growthDoneTodayClaimed: "今日旅行已完成 获得{credits}积分",
			growthClaimed: "今日共领取 {credits} 积分",
			growthCountdown: "旅行倒计时 {time}",
			checkinNow: "一键领取",
			checkinAlreadyDone: "今日已全部领完，无需再领",
			checkingIn: "正在签到…",
			checkinDone: "已签到",
			alreadyCheckedIn: "今天已签到",
			checkinFailed: "签到失败：{message}",
			checkinUnsupported: "国际版不支持",
			activeRefresh: "当前账号分钟数",
			inactiveRefresh: "其他账号分钟数",
			refreshPolicyHint: "后台只请求状态和余额；不会自动发起模型探测。",
			tabStatus: "状态",
			tabModels: "模型",
			accountHeading: "账号",
			creditsHeading: "剩余积分",
			creditsTotal: "剩余积分：{total}",
			creditsDetailHeading: "按类型",
			creditUsedOfSize: "已使用 {used} / {size}",
			creditBucketPlan: "套餐基础积分",
			creditBucketBonus: "平台奖励积分",
			creditPackageUnknownSize: "剩余 {remain}",
			creditPackageExpires: "到期时间：{time}",
			creditExpiresInDays: "剩余 {days} 天失效",
			creditExpired: "已失效",
			checkinNeedsScript: "请先开启签到脚本",
			creditsError: "积分查询失败：{message}",
			scopeHeading: "模型范围",
			scopeFree: "仅免费模型",
			scopeFreeHint: "只列出当前区域标记为 x0.00 的模型，不会产生任何扣费。",
			scopeAll: "全部模型",
			scopeAllHint: "同时列出付费模型。选用付费模型会按名称后标注的倍率真实扣费。",
			scopeSaving: "正在应用…",
			scopeFailed: "切换模型范围失败：{message}",
			scopeActive: "当前生效",
			scopePaid: "付费",
			scopeHidden: "被「仅免费」过滤",
			modelsHeading: "模型",
			modelsIntro: "倍率来自当前区域的 WorkBuddy 模型目录；国内版与国际版价格彼此独立。",
			modelsSwitchHint: "开关只控制模型选择器里的列表，不影响已选模型与模型请求。新模型默认显示。",
			modelEnabled: "在选择器中列出",
			modelsEmpty: "当前没有可用模型。",
			modelSearch: "搜索模型",
			modelsSelectAll: "全选",
			modelsUnselectAll: "取消全选",
			modelsNoMatch: "没有匹配的模型。",
			freeModel: "免费",
			rate: "{rate} 积分/次",
			contextWindow: "上下文 {tokens}",
			priceSourceCache: "价格读取自 WorkBuddy 应用缓存",
			priceSourceUpstream: "价格来自当前区域的实时模型目录",
			priceSourceBuiltin: "价格来自插件内置的免费名单（未能读取应用缓存）",
			priceSourcePath: "来源：{path}",
			probeHeading: "推理档位检测",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsent: "授权检测",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeLabel: "推理等级",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeFailed: "检测失败：{message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/**
		* Browser half: the WorkBuddy account and model-policy card as its own
		* section of the Settings sidebar.
		*
		* @module dsh-workbuddy/client
		*/
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-client";
		/**
		* Client services required by the Plugin configuration contribution.
		*
		* The `settings.section` slot is declared by `@deepseek-ai/dsh-client-ui-settings`
		* (through its settings-shell/general parts) and rendered as one entry of the
		* Settings sidebar, and the card's copy registers through
		* `@deepseek-ai/dsh-client-locale`; both are named in the package's
		* `dsh.client.inject` list, so cordis has activated them before this plugin's
		* fiber starts.
		*/
		const inject = ["slots", "locale"];
		/**
		* Register the card copy and the WorkBuddy card as one Settings sidebar
		* section.
		*
		* The body is wrapped so that a slot-API breaking change degrades to a
		* `console.error` instead of throwing into the DSH loader and raising the
		* "Failed to load plugins" banner. The host provider keeps working: the
		* `workbuddy-ai` model channel is unaffected, and
		* `dsh-workbuddy status` reports host health via the heartbeat file.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-ai";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy: settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "workbuddy-ai",
					order: 16,
					label: () => t("nav"),
					locale: namespace,
					inject: () => ({ t })
				}, WorkBuddyPluginCard));
			} catch (error) {
				console.error("[dsh-workbuddy] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
