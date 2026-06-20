import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.MCP_URL || "http://localhost:8787/burrow/9f3a7c2e1d/mcp";
const transport = new StreamableHTTPClientTransport(new URL(base));
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { isError: r.isError, text };
}

console.log("\n--- list_campgrounds ---");
const lc = await call("list_campgrounds", {});
if (lc.isError) { console.log("ERROR:", lc.text); process.exit(1); }
const parks = JSON.parse(lc.text);
console.log(`got ${parks.length} campgrounds; first 5:`);
for (const p of parks.slice(0, 5)) console.log(`  ${p.parkId}  ${p.name}  [${p.siteTypes.length} site types]`);

const target = parks.find((p) => p.parkId === "330126") || parks[0];
console.log(`\n--- get_availability ${target.parkId} (${target.name}) ---`);
const av = await call("get_availability", { parkId: target.parkId, startDate: "2026-07-15", nights: 14 });
if (av.isError) { console.log("ERROR:", av.text); process.exit(1); }
const grid = JSON.parse(av.text);
console.log(`slug=${grid.parkSlug} window=${grid.dates[0]}..${grid.dates.at(-1)} sites=${grid.sites.length}`);
const sample = grid.sites.filter((s) => s.available.length).slice(0, 3);
for (const s of sample) console.log(`  site ${s.siteId} "${s.label}" loop=${s.loop ?? "-"} avail=${s.available.length} days e.g. ${s.available.slice(0,3).join(",")}`);

console.log(`\n--- find_vacancies ${target.parkId} 2 nights 2026-07-15..2026-07-22 ---`);
const fv = await call("find_vacancies", { parkId: target.parkId, startDate: "2026-07-15", endDate: "2026-07-22", nights: 2 });
if (fv.isError) { console.log("ERROR:", fv.text); process.exit(1); }
const vac = JSON.parse(fv.text);
console.log(`found ${vac.count} vacancies; first 5:`);
for (const v of vac.vacancies.slice(0, 5)) console.log(`  site ${v.siteId} "${v.label}"  ${v.checkIn} -> ${v.checkOut}`);

await client.close();
console.log("\nOK");
