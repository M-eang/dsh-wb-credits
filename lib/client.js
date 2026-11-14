window.__ModuleLoader__.load({
	id: "dsh-wb-credits",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Browser half of dsh-wb-credits.
		 *
		 * Renders into `sidebar.footer.action` — the seat dsh-cost-meter's
		 * "今日 / 余额" card uses — and ships its own stylesheet so the card can
		 * fill whatever width the sidebar column currently has (the host gives
		 * this slot no width of its own; a plain flex item only shrinks to its
		 * content, which looked lopsided next to the cost-meter card).
		 *
		 * Every optional wiring step is try/caught and logged-never-thrown: the
		 * web shell fails the whole boot when a plugin apply throws.
		 */

		var React;
		try {
			React = require("react");
		} catch (error) {
			React = null;
		}

		var h = React ? React.createElement : null;

		var POLL_MS = 60000;
		var ENDPOINT = "/wb-credits/summary";
		var STYLE_ID = "dsh-wb-credits";

		var CSS = [
			/* 宿主把 footer 里的条目横着排，默认不换行 —— 我们这条要独占一行。 */
			":has(> .wbw-card){flex-wrap:wrap;align-items:stretch}",
			".wbw-card{",
			"--wbw-border:var(--dsw-alias-border-l1,rgba(128,128,128,.2));",
			"--wbw-label:var(--dsw-alias-label-secondary,inherit);",
			"--wbw-strong:var(--dsw-alias-label-primary,inherit);",
			"--wbw-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));",
			"box-sizing:border-box;width:100%;max-width:100%;min-width:0;flex:none;",
			"display:flex;flex-direction:column;gap:5px;",
			"margin:2px 0 4px;padding:8px 10px;",
			"border:1px solid var(--wbw-border);border-radius:12px;",
			"background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));",
			"color:var(--wbw-label);font-size:12px;line-height:16px;",
			"text-align:left;overflow:hidden;container-type:inline-size;",
			"}",
			".wbw-card:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.09))}",
			".wbw-card:focus-within{border-color:var(--dsw-alias-state-business-primary,rgba(128,128,128,.45))}",
			".wbw-head{display:flex;align-items:center;gap:6px;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;width:100%}",
			".wbw-head[type=button]{cursor:pointer}",
			".wbw-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--wbw-strong)}",
			".wbw-amount{flex:none;margin-left:auto;font-weight:600;color:var(--dsw-alias-state-business-primary,#3b82f6);font-variant-numeric:tabular-nums;letter-spacing:-.01em}",
			".wbw-amount-warn{color:var(--dsw-alias-state-warn-primary,#e8890c)}",
			".wbw-short{display:none}",
			".wbw-when{flex:none;margin-left:2px}",
			".wbw-row{display:flex;align-items:center;gap:6px;min-width:0}",
			".wbw-key{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".wbw-val{flex:none;margin-left:auto;font-variant-numeric:tabular-nums}",
			".wbw-bar{position:relative;height:6px;margin:1px 0 2px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));overflow:hidden}",
			".wbw-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b82f6);transition:width .3s ease}",
			".wbw-card[data-tone=warn] .wbw-fill{background:var(--dsw-alias-state-warn-primary,#e8890c)}",
			".wbw-card[data-tone=warn] .wbw-warn{color:var(--dsw-alias-state-warn-primary,#e8890c)}",
			".wbw-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:15px;color:var(--wbw-faint);font-variant-numeric:tabular-nums}",
			".wbw-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".wbw-icon{flex:none;width:18px;height:18px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:none;color:inherit;font-size:11px;line-height:1;cursor:pointer;opacity:.55}",
			".wbw-icon:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
			".wbw-icon:disabled{opacity:.3;cursor:default;background:none}",
			".wbw-caret{flex:none;margin-left:5px;font-size:9px;line-height:1;color:var(--wbw-faint);transition:transform .15s ease}",
			".wbw-card[data-open=true] .wbw-caret{transform:rotate(90deg)}",
			".wbw-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b82f6)}",
			".wbw-card[data-tone=warn] .wbw-dot{background:var(--dsw-alias-state-warn-primary,#e8890c)}",
			".wbw-card[data-tone=error] .wbw-dot{background:var(--dsw-alias-state-error-primary,#e5484d)}",
			".wbw-dot[data-busy=true]{opacity:.45}",
			".wbw-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".wbw-card[data-tone=error] .wbw-msg{color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".wbw-details{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding-top:6px;border-top:1px solid var(--wbw-border)}",
			".wbw-sep{height:5px}",
			".wbw-mini{display:flex;align-items:center;gap:6px;min-width:0;font-size:10.5px;line-height:14px;color:var(--wbw-faint);font-variant-numeric:tabular-nums}",
			".wbw-mini .wbw-key{flex:none;width:34px;font-variant-numeric:tabular-nums}",
			".wbw-track{flex:1 1 auto;min-width:0;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));overflow:hidden}",
			".wbw-track>span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-warn-primary,#e8890c);opacity:.85}",
			".wbw-rail{flex:none;width:32px;height:32px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:none;color:inherit;cursor:pointer}",
			".wbw-rail:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
			/* 侧边栏被拖窄时整体缩一号，拖宽时自然舒展开。 */
			/* 侧边栏拖到 180px 上下时，先砍次要信息再缩字号。 */
			"@container (max-width:160px){",
			".wbw-long{display:none}",
			".wbw-short{display:inline}",
			".wbw-when{display:none}",
			".wbw-pct{display:none}",
			"}",
			"@container (max-width:190px){",
			".wbw-card{padding:6px 8px;gap:3px;border-radius:10px;font-size:11px;line-height:15px}",
			".wbw-meta,.wbw-mini{font-size:10px;line-height:13px}",
			".wbw-bar{height:5px}",
			".wbw-mini .wbw-key{width:28px}",
			"}",
			"@container (min-width:300px){",
			".wbw-card{gap:5px;padding:9px 12px}",
			".wbw-meta,.wbw-mini{font-size:11px;line-height:15px}",
			"}",
		].join("");

		function ensureStyle() {
			try {
				if (typeof document === "undefined" || !document.head) return;
				var selector = 'style[data-plugin-css="' + STYLE_ID + '"]';
				var existing = document.querySelector(selector);
				if (existing && existing.textContent === CSS) return;
				var node = existing || document.createElement("style");
				node.dataset.plugin = "dsh-wb-credits";
				node.dataset.pluginCss = STYLE_ID;
				node.textContent = CSS;
				if (!existing) document.head.appendChild(node);
			} catch (error) {
				/* 样式挂了也要能渲染，只是回到朴素外观 */
			}
		}

		function fmt(value, digits) {
			var n = Number(value);
			if (!isFinite(n)) return "—";
			var max = digits == null ? (n < 100 ? 1 : 0) : digits;
			return n.toLocaleString("zh-CN", { maximumFractionDigits: max });
		}

		function shortDate(text) {
			// "2026-10-18 01:01" -> "10-18 01:01"
			if (!text) return "";
			var parts = String(text).split(" ");
			if (parts.length < 2) return String(text);
			return parts[0].slice(5) + " " + parts[1];
		}

		function hoursLeft(hours) {
			if (hours == null || !isFinite(hours)) return "";
			if (hours < 1) return Math.round(hours * 60) + " 分钟后";
			if (hours < 48) return Math.round(hours) + " 小时后";
			return Math.round(hours / 24) + " 天后";
		}

		function loadSummary(force) {
			var url = ENDPOINT + (force ? "?refresh=1" : "");
			return fetch(url, { headers: { accept: "application/json" } }).then(function (res) {
				return res.json();
			});
		}

		function useCredits() {
			var state = React.useState(null);
			var data = state[0];
			var setData = state[1];
			var errState = React.useState("");
			var error = errState[0];
			var setError = errState[1];
			var busyState = React.useState(true);
			var busy = busyState[0];
			var setBusy = busyState[1];

			var refresh = React.useCallback(function (force) {
				setBusy(true);
				return loadSummary(force)
					.then(function (json) {
						if (json && json.ok) {
							setData(json);
							setError("");
						} else {
							setError((json && json.error) || "读取失败");
						}
					})
					.catch(function (error) {
						setError(String((error && error.message) || error));
					})
					.finally(function () {
						setBusy(false);
					});
			}, []);

			// 节奏由服务器给（ssh 模式每轮是一次 SSH 往返，别写死 60 秒）。
			var pollMs = (data && data.poll_seconds ? Number(data.poll_seconds) : POLL_MS / 1000) * 1000;
			if (!isFinite(pollMs) || pollMs < 15000) pollMs = POLL_MS;

			React.useEffect(function () {
				refresh(false);
				var timer = setInterval(function () {
					refresh(false);
				}, pollMs);
				return function () {
					clearInterval(timer);
				};
			}, [refresh, pollMs]);

			return { data: data, error: error, busy: busy, refresh: refresh };
		}

		function soonestOf(data) {
			var detail = (data && data.accounts_detail) || [];
			var best = null;
			detail.forEach(function (row) {
				if (!row.soonest_at) return;
				if (!best || row.soonest_at < best.soonest_at) best = row;
			});
			return best;
		}

		function Details(props) {
			var data = props.data;
			var rows = [];
			var detail = (data && data.accounts_detail) || [];

			detail.slice(0, 6).forEach(function (row, index) {
				rows.push(
					h(
						"div",
						{ key: "acc" + index, className: "wbw-row wbw-mini" },
						h("span", { className: "wbw-key", title: row.nickname }, row.nickname),
						h("span", { className: "wbw-val" }, fmt(row.remain)),
					),
				);
			});

			if (data && data.buckets && data.buckets.length > 0) {
				var max = 1;
				data.buckets.slice(0, 8).forEach(function (bucket) {
					if (bucket.amount > max) max = bucket.amount;
				});
				rows.push(h("div", { key: "gap", className: "wbw-sep" }));
				data.buckets.slice(0, 8).forEach(function (bucket, index) {
					rows.push(
						h(
							"div",
							{ key: "b" + index, className: "wbw-mini" },
							h("span", { className: "wbw-key" }, String(bucket.date).slice(5)),
							h(
								"span",
								{ className: "wbw-track" },
								h("span", {
									style: { width: Math.max(3, Math.min(100, (bucket.amount / max) * 100)) + "%" },
								}),
							),
							h("span", { className: "wbw-val" }, fmt(bucket.amount)),
						),
					);
				});
			}

			if (data && data.beyond_7d > 0) {
				rows.push(
					h("div", { key: "beyond", className: "wbw-mini" },
						h("span", { className: "wbw-grow" }, "7 天之外还有 " + fmt(data.beyond_7d)),
					),
				);
			}

			if (data && data.generated_at) {
				var via = data.provider === "api" ? "只读接口" : data.provider === "panel" ? "面板接口" : "SSH";
				rows.push(
					h("div", { key: "ts", className: "wbw-mini" },
						h("span", { className: "wbw-grow" }, via + " · " + String(data.generated_at).slice(5, 16)),
					),
				);
			}

			return h("div", { className: "wbw-details" }, rows);
		}

		function SidebarCredits(props) {
			var credits = useCredits();
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var data = credits.data;
			var error = credits.error;
			var wide = props == null || props.wide !== false;

			var soonest = soonestOf(data);
			var tone = error && !data ? "error" : "ok";
			var total = (data && data.total_remain) || 0;
			var expiring = (data && data.expiring_7d) || 0;
			var ratio = total > 0 ? expiring / total : 0;
			if (ratio >= 0.25) tone = "warn";

			// 侧边栏收成 56px 竖排时只留一个圆点，数字挂在 title 上。
			if (!wide) {
				var tip = error
					? "积分读取失败：" + error
					: data
						? fmt(data.total_remain) + " 积分 · 7 天到期 " + fmt(data.expiring_7d)
						: "积分加载中…";
				return h(
					"button",
					{
						type: "button",
						className: "wbw-rail",
						title: tip,
						"aria-label": tip,
						onClick: function () { credits.refresh(true); },
					},
					h("span", {
						className: "wbw-dot",
						"data-busy": credits.busy ? "true" : "false",
						style: tone === "error" ? { background: "var(--dsw-alias-state-error-primary,#e5484d)" } : undefined,
					}),
				);
			}

			var metaText;
			var metaWhen = "";
			if (soonest && soonest.soonest_at) {
				metaText = "首到期 " + shortDate(soonest.soonest_at);
				metaWhen = hoursLeft(soonest.hours_left);
			} else if (error) {
				metaText = error;
			} else if (data) {
				metaText = "没有快到期的积分";
			} else {
				metaText = "加载中…";
			}

			var head = h(
				"button",
				{
					type: "button",
					className: "wbw-head",
					"aria-expanded": open ? "true" : "false",
					title: open ? "收起明细" : "展开账号明细",
					onClick: function () { setOpen(!open); },
				},
				h(
					"span",
					{ className: "wbw-name" },
					h("span", { className: "wbw-long" }, "WorkBuddy 积分"),
					h("span", { className: "wbw-short" }, "WB 积分"),
				),
				data
					? h("span", { className: "wbw-amount" + (tone === "warn" ? " wbw-amount-warn" : "") }, fmt(total))
					: null,
				h("span", { className: "wbw-caret" }, "▸"),
			);

			var body = null;
			if (!data) {
				body = h("div", { className: "wbw-row" },
					h("span", { className: "wbw-msg wbw-grow" }, error ? "积分读取失败：" + error : "读取中…"),
				);
			} else {
				body = h(
					React.Fragment,
					null,
					h(
						"div",
						{ className: "wbw-row" },
						h("span", { className: "wbw-key" }, "7 天到期"),
						h("span", { className: "wbw-val" + (ratio >= 0.25 ? " wbw-warn" : "") },
							fmt(expiring),
							total > 0 ? h("span", { className: "wbw-pct" }, "（" + Math.round(ratio * 100) + "%）") : null,
						),
					),
					h("div", { className: "wbw-bar" },
						h("span", { className: "wbw-fill", style: { width: Math.max(0, Math.min(100, ratio * 100)) + "%" } }),
					),
					h(
						"div",
						{ className: "wbw-meta" },
						h(
							"span",
							{ className: "wbw-grow", title: metaText + (metaWhen ? " · " + metaWhen : "") },
							metaText,
							metaWhen ? h("span", { className: "wbw-when" }, " · " + metaWhen) : null,
						),
						h(
							"button",
							{
								type: "button",
								className: "wbw-icon",
								title: "立即重新读取",
								"aria-label": "立即重新读取",
								disabled: credits.busy,
								onClick: function (event) {
									event.stopPropagation();
									credits.refresh(true);
								},
							},
							credits.busy ? "…" : "⟳",
						),
					),
					open ? h(Details, { data: data }) : null,
				);
			}

			return h(
				"div",
				{
					className: "wbw-card",
					"data-tone": tone,
					"data-open": open ? "true" : "false",
				},
				head,
				body,
			);
		}

		ensureStyle();

		function apply(ctx) {
			if (!React) {
				console.warn("[dsh-wb-credits] react not available; browser half skipped");
				return;
			}
			ctx.inject(["slots"], function (slotsCtx) {
				var slots = slotsCtx.slots;
				return slots.inject("sidebar.footer.action", function () {
					try {
						return slots.register(
							{ name: "sidebar.footer.action", id: "wb-credits", order: 20 },
							SidebarCredits,
						);
					} catch (error) {
						console.warn("[dsh-wb-credits] slot registration failed", error);
						return function () {};
					}
				});
			});
		}

		module.exports.name = "wb-credits";
		module.exports.inject = [];
		module.exports.apply = apply;

		return module.exports;
	},
});
