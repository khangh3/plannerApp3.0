# Planner

React, TypeScript, and Vite planner backed by local Supabase accounts and PostgreSQL.

## Local development

1. Install Node.js and Docker Desktop. Start Docker Desktop with its Linux container engine running.
2. Run `npm install`.
3. Run `npm run db:start`. The first start downloads Supabase container images and applies the migrations under `supabase/migrations`.
4. Run `npm run db:status` to see the local API, Studio, and public client key.
5. Copy `.env.example` to `.env.local`. Set `VITE_SUPABASE_ANON_KEY` to the local publishable key reported by Supabase (the local anon key is also supported by Supabase clients). Keep `VITE_SUPABASE_URL=http://127.0.0.1:55321`. Never put a secret/service-role key in a Vite environment variable.
6. Run `npm run dev` and open the URL Vite prints. Create an account to begin. Local email confirmation is disabled, so signup signs you in immediately.

`npm run db:stop` stops the local stack while preserving its database. `npm run db:start` starts it again. `npm run db:status` reports its endpoints. **`npm run db:reset` destroys the local database contents and reapplies migrations**; use it only when you intend to clear local accounts and planner data. Docker must be running for these commands.

`npm run build` checks TypeScript and produces the production build. `npm run lint` runs Oxlint. `npm test` runs recurrence tests. `npm run test:db` runs the opt-in local database smoke tests described below.

## Data model

Each account has a profile and its own categories and time blocks. Signup creates Work, Personal, and Focus categories. Row-level security isolates every user's data, including weekdays and exceptions through their parent block. Deleting an account deletes its data; deleting a block deletes its weekdays and exceptions. A category in use cannot be deleted.

One-off blocks store absolute `start_at`/`end_at` timestamps. Recurring blocks store local `HH:mm` clock times, an end-day offset, an IANA time zone, and a weekly recurrence rule. Recurrence dates are PostgreSQL `date` values. Weeks start Sunday, interval counts weeks from the week containing the inclusive start date, and weekdays use Sunday = 0 through Saturday = 6. End modes are never, an inclusive date, or a positive occurrence count. Counts include skipped and replaced dates.

Exceptions identify the original local occurrence date. Detaching an occurrence atomically replaces it with an independent one-off block and records its origin. The detached block may move or change freely while retaining a Restore to series action. Restore uses the current series settings and discards the custom block only if the original date is still scheduled; otherwise it fails without losing edits. Deleting a detached block leaves the original date skipped. Deleting the series preserves its detached blocks as independent blocks and clears their origins.

Authenticated RPCs atomically save, skip, detach, restore, and delete schedules. Direct schedule-table writes are revoked; reads retain row-level security. RPCs check ownership, and category foreign keys enforce account separation. Series edits retain replacement links even when their dates leave the schedule. The new migration converts existing timestamp schedules and exceptions using their original named zones; it does not reset user data.

Creating, editing, detaching, and restoring blocks rejects overlapping occupied time, including flexible blocks and recurring occurrences. Back-to-back endpoints are allowed. Skipped/replaced occurrences are excluded, and a series cannot overlap itself. Writes are serialized per account so simultaneous saves cannot bypass the check. Recurrence checks cover the planner's supported four-digit calendar dates (years 0001–9999), including future dates beyond the displayed week. Long unbounded schedules can take longer to validate. Existing blocks are preserved; a conflicting edit fails without changing its prior values.

For an existing local stack, apply pending migrations with `npx supabase migration up --local`. Do not use `db:reset` to upgrade a database you want to preserve.

Local auth settings are for development. Configure deployment URLs, email delivery, and email confirmation separately before deploying a hosted environment. No production credentials are included here.

## Database smoke tests

With the local stack running and `.env.local` configured, run `npm run test:db`. This opt-in test accepts only loopback Supabase URLs. It creates two disposable accounts and checks signup defaults, transactional saves, recurrence/exception constraints, cascades, and access isolation. It removes their planner data afterward. To also remove the disposable auth accounts, supply the local service-role key through the `SUPABASE_SERVICE_ROLE_KEY` process environment; never commit this key or expose it to Vite. Without that optional key, test accounts and profiles remain until a deliberate local reset.
