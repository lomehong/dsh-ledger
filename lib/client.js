window.__ModuleLoader__.load({
	id: "@dsh-extra/dsh-ledger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  LedgerPluginConfig: () => LedgerPluginConfig,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots"];
var c = {
  text: "var(--dsw-alias-label-primary, #1f2329)",
  sub: "var(--dsw-alias-label-secondary, #4e5969)",
  faint: "var(--dsw-alias-label-tertiary, #86909c)",
  bg: "var(--dsw-alias-bg-base, #ffffff)",
  layer: "var(--dsw-alias-bg-layer-1, #f7f8fa)",
  border: "var(--dsw-alias-separator-primary, #e5e6eb)",
  ok: "var(--dsw-alias-state-success-primary, #00b42a)",
  warn: "var(--dsw-alias-state-warn-primary, #ff7d00)"
};
var sectionStyle = { border: `1px solid ${c.border}`, borderRadius: 8, padding: "12px 16px", background: c.bg, marginBottom: 12 };
var titleStyle = { fontSize: 13, fontWeight: 600, color: c.text, margin: "0 0 8px" };
var hintStyle = { fontSize: 12, color: c.sub, lineHeight: 1.5 };
var cellStyle = { padding: "10px 14px", borderRadius: 8, background: c.layer, textAlign: "center", minWidth: 84 };
var cellNumStyle = { fontSize: 20, fontWeight: 700, color: c.text };
var cellLabelStyle = { fontSize: 11.5, color: c.faint, marginTop: 2 };
function StatsPage() {
  const [data, setData] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    fetch("/dsh-ledger/stats", { headers: { Accept: "application/json" } }).then((r) => r.json()).then((d) => {
      if (d.ok) setData(d);
      else setError(true);
    }).catch(() => setError(true));
  }, []);
  if (error) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...hintStyle, color: c.warn }, children: "\u8D26\u672C\u72B6\u6001\u83B7\u53D6\u5931\u8D25\uFF08dsh-ledger \u5BBF\u4E3B\u670D\u52A1\u4E0D\u53EF\u7528\uFF1F\uFF09\u3002" });
  if (data === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: hintStyle, children: "\u52A0\u8F7D\u8D26\u672C\u72B6\u6001\u4E2D\u2026" });
  const s = data.stats;
  const h = data.health;
  const pendingCount = Array.isArray(data.pending) ? data.pending.length : s?.pendingApprovals ?? 0;
  const cells = [
    ["\u8D26\u672C\u8BB0\u5F55", s?.total ?? 0],
    ["\u6D3B\u8DC3\u6388\u6743", s?.activeGrants ?? 0],
    ["\u5F85\u6279\u5BA1\u6279", pendingCount],
    ["\u4E8B\u540E\u5426\u51B3\u7387", s?.rejectedRate != null ? `${Math.round(s.rejectedRate * 100)}%` : "\u2014"]
  ];
  const byStatus = Object.entries(s?.byStatus ?? {});
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { maxWidth: 720 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: sectionStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: titleStyle, children: "\u88C1\u51B3\u7EDF\u8BA1" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: cells.map(([label, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cellStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: cellNumStyle, children: v }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: cellLabelStyle, children: label })
      ] }, label)) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...hintStyle, marginTop: 8 }, children: byStatus.length > 0 ? byStatus.map(([k, v]) => `${k}\xD7${v}`).join(" \xB7 ") : "\u6682\u65E0\u8BB0\u5F55" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: sectionStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...titleStyle, display: "flex", gap: 8, alignItems: "center" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u6267\u884C\u95F8\uFF08opt-in\uFF09" }),
        h?.gateAttached === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 11.5, fontWeight: 600, color: c.ok }, children: [
          "\u2713 \u5DF2\u6302\u63A5",
          h.gateChannel !== void 0 && h.gateChannel !== "none" ? ` \xB7 ${h.gateChannel}` : ""
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 11.5, fontWeight: 600, color: c.warn }, children: "\u672A\u6302\u63A5\uFF08\u4E8B\u4EF6\u9762\u7F3A\u5E2D\uFF0C\u8D26\u672C\u4EC5\u8BB0\u5F55\u4E0D\u62E6\u622A\uFF09" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: hintStyle, children: "\u53EA\u88C1\u51B3\u663E\u5F0F\u58F0\u660E args.actionType \u7684\u5DE5\u5177\u8C03\u7528\uFF08\u672A\u77E5\u52A8\u4F5C\u515C\u5E95 L2 fail-closed\uFF09\uFF1B \u666E\u901A\u5DE5\u4F5C\u5DE5\u5177\u672A\u58F0\u660E\u6CBB\u7406\u610F\u56FE\uFF0C\u4E00\u5F8B\u653E\u884C\u2014\u2014\u4E3B\u4EBA\u65E5\u5E38\u4F1A\u8BDD\u5168\u80FD\u529B\u3002" }),
      h?.issues !== void 0 && h.issues.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...hintStyle, color: c.warn, marginTop: 6 }, children: [
        "\u95EE\u9898\uFF1A",
        h.issues.join("\uFF1B")
      ] })
    ] })
  ] });
}
function LedgerPluginConfig(props) {
  if (props.view === "page") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatsPage, {});
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: c.sub }, children: "\u59D4\u6258\u8D26\u672C\uFF1AL0\u2013L3 \u5206\u7EA7\u88C1\u51B3 \xB7 \u5BA1\u6279\u4EE4\u724C\uFF083 \u5206\u949F\u8D85\u65F6 fail-closed\uFF09\xB7 \u7ED3\u679C\u56DE\u586B\uFF1B\u6388\u6743\u662F\u6570\u636E\uFF0C\u6267\u884C\u5728\u673A\u5236\u3002" });
}
function apply(ctx) {
  ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register(
      { name: "plugins.bundle.config", key: "@dsh-extra/dsh-ledger" },
      (props) => LedgerPluginConfig({ view: props.view })
    )
  );
}
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
