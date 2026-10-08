// Explicitly invoked only; never resets or migrates the database.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { TIME_BLOCK_SELECT } from "../src/lib/timeBlockSelect.ts";
let env = {};
try {
  env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, "")];
      }),
  );
} catch {}
const url = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url || !key)
  throw new Error("Configure local Supabase URL and public key first.");
const parsed = new URL(url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  throw new Error("Database tests only accept loopback URLs.");
const clients = [];
const users = [];
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
const bad = (r) => assert.ok(r.error, "Expected database rejection");
const create = async () => {
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clients.push(db);
  const auth = ok(
    await db.auth.signUp({
      email: `planner-smoke-${crypto.randomUUID()}@example.com`,
      password: `Local-${crypto.randomUUID()}!`,
    }),
  );
  assert.ok(auth.session);
  users.push(auth.user.id);
  return db;
};
try {
  const a = await create(),
    b = await create();
  const cats = ok(await a.from("categories").select("*"));
  assert.equal(cats.length, 3);
  const cat = cats[0].id;
  const base = {
    title: "Smoke schedule",
    categoryId: cat,
    availability: "busy",
    timezone: "America/Chicago",
  };
  const series = {
    ...base,
    kind: "recurring",
    startTime: "09:00",
    endTime: "10:00",
    endDayOffset: 0,
    recurrence: {
      frequency: "weekly",
      interval: 2,
      weekdays: [0, 2],
      startDate: "2026-10-06",
      end: { kind: "count", count: 3 },
    },
  };
  const save = (db, draft, id = null) =>
    db.rpc("save_time_block", { p_draft: draft, p_id: id });
  for (const end of [{}, { kind: "until" }, { kind: "count" }])
    bad(
      await save(a, { ...series, recurrence: { ...series.recurrence, end } }),
    );
  const sid = ok(await save(a, series));
  assert.equal(
    ok(await b.from("time_blocks").select("*").eq("id", sid)).length,
    0,
  );
  bad(await save(b, series, sid));
  bad(await b.rpc("delete_time_block", { p_id: sid }));
  bad(
    await save(b, {
      ...base,
      kind: "oneOff",
      startAt: "2026-10-06T10:00:00Z",
      endAt: "2026-10-06T11:00:00Z",
    }),
  );
  bad(await a.from("time_blocks").update({ title: "bypass" }).eq("id", sid));
  bad(
    await save(
      a,
      { ...series, recurrence: { ...series.recurrence, weekdays: [] } },
      sid,
    ),
  );
  assert.equal(
    ok(await a.from("time_block_weekdays").select("*").eq("time_block_id", sid))
      .length,
    2,
    "Failed update rolled back",
  );
  bad(
    await a.rpc("skip_occurrence", {
      p_series_id: sid,
      p_occurrence_date: "2026-10-13",
    }),
  );
  bad(
    await a.rpc("skip_occurrence", {
      p_series_id: sid,
      p_occurrence_date: "2026-11-01",
    }),
  );
  const replacement = {
    ...base,
    kind: "oneOff",
    startAt: "2026-10-07T14:00:00Z",
    endAt: "2026-10-07T15:00:00Z",
  };
  const detach = () =>
    a.rpc("detach_occurrence", {
      p_series_id: sid,
      p_occurrence_date: "2026-10-06",
      p_draft: replacement,
    });
  bad(
    await a.rpc("detach_occurrence", {
      p_series_id: sid,
      p_occurrence_date: "2026-10-06",
      p_draft: { ...replacement, endAt: replacement.startAt },
    }),
  );
  assert.equal(
    ok(
      await a
        .from("time_block_exceptions")
        .select("*")
        .eq("time_block_id", sid),
    ).length,
    0,
    "Failed detach rolled back skip",
  );
  const races = await Promise.all([detach(), detach()]);
  assert.equal(
    races.filter((r) => !r.error).length,
    1,
    "Concurrent detach creates one replacement",
  );
  const rid = races.find((r) => !r.error).data;
  const embeddedSeries = ok(
    await a.from("time_blocks").select(TIME_BLOCK_SELECT).eq("id", sid).single(),
  );
  assert.equal(embeddedSeries.time_block_exceptions.length, 1);
  assert.equal(embeddedSeries.time_block_exceptions[0].replacement_block_id, rid);
  const embeddedReplacement = ok(
    await a.from("time_blocks").select(TIME_BLOCK_SELECT).eq("id", rid).single(),
  );
  assert.deepEqual(embeddedReplacement.time_block_exceptions, [],
    "A replacement must not embed its parent series exception");
  bad(await b.rpc("restore_occurrence", { p_replacement_id: rid }));
  ok(await save(a, { ...replacement, title: "Custom edited" }, rid));
  assert.equal(
    ok(
      await a
        .from("time_blocks")
        .select("origin_series_id")
        .eq("id", rid)
        .single(),
    ).origin_series_id,
    sid,
  );
  bad(await save(a, series, rid));
  ok(
    await save(
      a,
      { ...series, recurrence: { ...series.recurrence, weekdays: [0] } },
      sid,
    ),
  );
  bad(await a.rpc("restore_occurrence", { p_replacement_id: rid }));
  assert.equal(
    ok(await a.from("time_blocks").select("*").eq("id", rid)).length,
    1,
    "Invalid restore preserves custom block",
  );
  assert.equal(
    ok(
      await a
        .from("time_block_exceptions")
        .select("*")
        .eq("time_block_id", sid),
    ).length,
    1,
    "Series edits retain replacement links",
  );
  ok(await save(a, series, sid));
  const restores = await Promise.all([
    a.rpc("restore_occurrence", { p_replacement_id: rid }),
    a.rpc("restore_occurrence", { p_replacement_id: rid }),
  ]);
  assert.equal(restores.filter((r) => !r.error).length, 1);
  assert.equal(
    ok(await a.from("time_blocks").select("*").eq("id", rid)).length,
    0,
  );
  const rid2 = ok(await detach());
  ok(await a.rpc("delete_time_block", { p_id: rid2 }));
  const skipped = ok(
    await a
      .from("time_block_exceptions")
      .select("*")
      .eq("time_block_id", sid)
      .single(),
  );
  assert.equal(skipped.kind, "skipped");
  assert.equal(skipped.replacement_block_id, null);
  const rid3 = ok(
    await a.rpc("detach_occurrence", {
      p_series_id: sid,
      p_occurrence_date: "2026-10-18",
      p_draft: replacement,
    }),
  );
  ok(await a.rpc("delete_time_block", { p_id: sid }));
  const independent = ok(
    await a.from("time_blocks").select("*").eq("id", rid3).single(),
  );
  assert.equal(independent.origin_series_id, null);
  assert.equal(independent.origin_occurrence_date, null);
  const noOverlap = (result) => {
    bad(result);
    assert.equal(result.error.code, "23P01");
    assert.match(result.error.message, /overlap/i);
  };
  const single = (start, end, title = "Overlap test") => ({
    ...base, title, kind: "oneOff", startAt: start, endAt: end,
  });
  const firstDraft = single("2030-01-07T15:00:00Z", "2030-01-07T16:00:00Z");
  const first = ok(await save(a, firstDraft));
  noOverlap(await save(a, single("2030-01-07T15:30:00Z", "2030-01-07T16:30:00Z")));
  noOverlap(await save(a, single("2030-01-07T14:00:00Z", "2030-01-07T17:00:00Z")));
  noOverlap(await save(a, { ...firstDraft, availability: "flexible" }));
  ok(await save(a, { ...firstDraft, title: "Edit myself" }, first));
  const adjacent = ok(await save(a, single("2030-01-07T16:00:00Z", "2030-01-07T17:00:00Z")));
  noOverlap(await save(a, single("2030-01-07T15:45:00Z", "2030-01-07T17:00:00Z"), adjacent));
  assert.equal(ok(await a.from("time_blocks").select("start_at").eq("id", adjacent).single()).start_at,
    "2030-01-07T16:00:00+00:00", "Rejected edit preserves old time");
  const weekly = { ...series, recurrence: { frequency: "weekly", interval: 1,
    weekdays: [1], startDate: "2030-01-07", end: { kind: "never" } } };
  noOverlap(await save(a, weekly));
  ok(await a.rpc("delete_time_block", { p_id: first }));
  ok(await a.rpc("delete_time_block", { p_id: adjacent }));
  const weeklyId = ok(await save(a, weekly));
  const secondWeekly = ok(await save(a, { ...weekly, startTime: "10:00", endTime: "11:00" }));
  noOverlap(await save(a, { ...weekly, startTime: "09:30", endTime: "10:30" }));
  noOverlap(await save(a, single("2080-01-08T15:00:00Z", "2080-01-08T16:00:00Z")));
  ok(await a.rpc("skip_occurrence", { p_series_id: weeklyId, p_occurrence_date: "2030-01-07" }));
  const inSkip = ok(await save(a, firstDraft));
  noOverlap(await save(a, { ...weekly, startTime: "09:30", endTime: "10:30" }, weeklyId));
  ok(await a.rpc("delete_time_block", { p_id: inSkip }));
  const detached = ok(await a.rpc("detach_occurrence", { p_series_id: weeklyId,
    p_occurrence_date: "2030-01-14", p_draft: single("2030-01-15T15:00:00Z", "2030-01-15T16:00:00Z") }));
  const filled = ok(await save(a, single("2030-01-14T15:00:00Z", "2030-01-14T16:00:00Z")));
  noOverlap(await a.rpc("restore_occurrence", { p_replacement_id: detached }));
  assert.equal(ok(await a.from("time_blocks").select("id").eq("id", detached)).length, 1);
  ok(await a.rpc("delete_time_block", { p_id: filled }));
  ok(await a.rpc("restore_occurrence", { p_replacement_id: detached }));
  noOverlap(await a.rpc("detach_occurrence", { p_series_id: weeklyId,
    p_occurrence_date: "2030-01-21", p_draft: single("2030-01-21T16:15:00Z", "2030-01-21T16:45:00Z") }));
  assert.equal(ok(await a.from("time_block_exceptions").select("id").eq("time_block_id", weeklyId).eq("occurrence_date", "2030-01-21")).length, 0);
  ok(await a.rpc("delete_time_block", { p_id: weeklyId }));
  ok(await a.rpc("delete_time_block", { p_id: secondWeekly }));
  const overnight = { ...weekly, startTime: "22:00", endTime: "02:00", endDayOffset: 1,
    recurrence: { ...weekly.recurrence, end: { kind: "count", count: 2 } } };
  const overnightId = ok(await save(a, overnight));
  noOverlap(await save(a, single("2030-01-08T07:00:00Z", "2030-01-08T09:00:00Z")));
  ok(await a.rpc("delete_time_block", { p_id: overnightId }));
  noOverlap(await save(a, { ...overnight, endDayOffset: 8 }));
  const dst = { ...weekly, startTime: "09:00", endTime: "10:00",
    recurrence: { ...weekly.recurrence, weekdays: [0], startDate: "2030-03-03",
      end: { kind: "count", count: 2 } } };
  const dstId = ok(await save(a, dst));
  noOverlap(await save(a, single("2030-03-10T14:30:00Z", "2030-03-10T15:30:00Z")));
  const afterCount = ok(await save(a, single("2030-03-17T14:00:00Z", "2030-03-17T15:00:00Z")));
  ok(await a.rpc("delete_time_block", { p_id: dstId }));
  ok(await a.rpc("delete_time_block", { p_id: afterCount }));
  noOverlap(await save(a, { ...weekly, startTime: "03:00", endTime: "02:30", endDayOffset: 1,
    recurrence: { ...weekly.recurrence, weekdays: [6, 0], startDate: "2030-03-09",
      end: { kind: "count", count: 2 } } }));
  const raceDraft = single("2031-01-01T15:00:00Z", "2031-01-01T16:00:00Z");
  const saves = await Promise.all([save(a, raceDraft), save(a, raceDraft)]);
  assert.equal(saves.filter(r => !r.error).length, 1, "Concurrent saves cannot overlap");
  noOverlap(saves.find(r => r.error));
  const otherCategory = ok(await b.from("categories").select("id").limit(1).single());
  ok(await save(b, { ...raceDraft, categoryId: otherCategory.id }));
  console.log(
    "Database smoke tests passed: isolation, rollback, recurrence, detach/restore, overlap prevention, adjacency, overnight blocks, and concurrent saves.",
  );
} finally {
  for (const db of clients) {
    const rows = ok(await db.from("time_blocks").select("id"));
    for (const row of rows) await db.rpc("delete_time_block", { p_id: row.id });
    await db.from("categories").delete().neq("id", 0);
  }
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    for (const id of users) ok(await admin.auth.admin.deleteUser(id));
  } else
    console.log(
      "Disposable auth accounts retained; set SUPABASE_SERVICE_ROLE_KEY to remove them after tests.",
    );
}
