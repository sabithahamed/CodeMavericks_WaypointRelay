# Waypoint Relay: Code Mavericks

**Tech-Triathlon 2026 · Hackathon submission.** One delivery record that runs from the store's order through the dispatcher's plan, the loading dock and the driver's phone, back to the store's receipt confirmation. It is built for Waypoint Group's shared fleet, where demand regularly exceeds capacity and field connectivity drops.

- **Deployed:** https://waypointrelay-5crm.onrender.com (free tier: the first visit after idle can take about a minute to wake)
- **Docs:** [architecture](docs/architecture.md) · [data model](docs/data-model.md) · [AI tool disclosure](docs/ai-disclosure.md)

## Seeded accounts

Password for all four: **`relay2026`**. The sign-in page also has one-click buttons to fill these in.

| Role | Email | Scope |
|---|---|---|
| Dispatcher | `dispatcher@waypoint.test` | Peliyagoda planning office |
| Loader | `loader@waypoint.test` | Peliyagoda dock |
| Driver | `driver@waypoint.test` | VEH036, the only available refrigerated van on the day |
| Store manager | `store@waypoint.test` | OUT002, a van-only Fresh outlet in Colombo with one ambient and one chilled order |

The seeded delivery day is **Scenario S1** (Mon 5 Oct 2026, Peliyagoda): 85 orders, 28 available vehicles and 10 in the workshop, with a festival one week away. It is loaded from the shared datasets.

## Run it

**1. Add the seed data.** The competition datasets may not be redistributed (Challenge Booklet, Terms and Conditions), so they are **not in this repository**. Copy the six required CSVs from the Tech-Triathlon dataset folder into `seed/data/`. The exact list and a copy command are in [seed/data/README.md](seed/data/README.md).

**2. Start the stack.**

```bash
docker compose up --build
```

Open http://localhost:8080. The app creates the schema and seeds the shared datasets, the four accounts and the S1 day on first start (`.env.example` lists the optional overrides).

Without Docker (Node 22 and PostgreSQL required):

```bash
npm install
npm run build                      # builds the web app
DATABASE_URL=postgres://relay:relay@localhost:5432/relay npm start
```

Tests:

```bash
npm test                                                     # planner unit tests
DATABASE_URL=postgres://relay:relay@localhost:5432/relay npm test   # + end-to-end walkthrough
npx tsx scripts/export-s1.ts s1.csv && python ../Dataset/check_allocation.py s1.csv   # organizers' validator
```

## Judge walkthrough

Use a desktop browser for the dispatcher, and a phone or the browser's device toolbar (about 390 px wide) for the loader and driver. To start over at any time, use **Daily plan → Reset demo day**.

1. **Store places an order (S2).** Sign in as **store**, choose **Place an order**, keep *Dry / ambient*, enter `4` dry grocery cases and **Submit order**. The order is confirmed immediately with its delivery day, so the store no longer has to wonder whether a phone order was received.
2. **Dispatcher closes orders (D1).** Sign in as **dispatcher** and click **Close orders**. The new `WR-00001` order appears in the queue. Orders placed after this go to the following run, and the store is told which.
3. **Build the plan (D1).** Click **Build plan**. 73 of 85 orders are served with **0 rule violations**. The amber banner proves the chilled shortfall (181.6 m³ of demand against at most 172.4 m³ of refrigerated capacity), so some deferrals are unavoidable.
   - Open the **Deferred** tab. **S1-078** is marked *Needs revision*: at 40.66 m³ it exceeds every vehicle (max 38 m³), so waiting a day will not fix it.
   - Click **S1-003** (OUT002 chilled). The drawer shows it on VEH036 and lists compatible vehicles. Infeasible ones explain why (for example, weight over the limit, or too late for the window). Trucks are never offered, because OUT002 is van-only.
   - Optionally move an order or **defer with a reason**. The server re-validates every change.
4. **Review & publish (D2).** Check the deferral list and the repeat-deferral warning, tick the confirmation and click **Publish**. Stores now see an ETA or the deferral reason.
5. **Loader checks the run (L1, phone).** Sign in as **loader** and open the **VEH036** trip that includes OUT002. Click **I have the v1 list**, then on one order click **Missing / damaged**, enter fewer units and a note, and choose **Report & hold run**. The run is now *Held*.
6. **Dispatcher decides (D3).** As **dispatcher**, open **Progress & exceptions**. The shortfall is under *Needs your decision*. Type a decision and click **Send short and release hold**. (*Defer this order* creates plan v2, which the loader must acknowledge again.)
7. **Loader releases.** As **loader**, mark the remaining orders loaded and click **Release for departure**.
8. **Driver works offline (R1–R3, phone). This is the degradation scenario, *Delivery recorded, connection lost*.**
   - Sign in as **driver**. **Acknowledge** the trip, then **Start trip**.
   - Tap **Simulate no signal** in the status bar, or turn on airplane mode.
   - Open the **OUT002** stop, choose **Delivered**, optionally add a photo, and **Save**. The screen reads *Delivery saved on this phone. Not uploaded yet.*
   - **Saved work** lists exactly what is only on the phone.
   - Tap **Restore signal**. The items upload, and a photo shows *Uploaded · photo pending* until its separate upload finishes.
   - Retries are de-duplicated, so the same record can never create two deliveries.
9. **Store confirms receipt (S3).** As **store**, open the order. The driver's record and the store's own confirmation are shown separately. Choose **Confirm receipt**, or **Report an issue** to raise an exception for the dispatcher.
10. **Dispatcher sees the closed loop (D3, D4).** **Progress & exceptions** shows each stop's state and when the office last heard from it. **Capacity outlook** shows weekly total and chilled demand by depot and brand for the next 10 weeks, including the refrigerated trips needed.

*Conflict case:* if the dispatcher re-plans and an order moves while a driver is offline, the driver's record is kept, flagged *dispatcher review needed* on the phone, and raised as a conflict in D3. It is never silently discarded.

## Operating constraints enforced

Weight **and** volume per trip · refrigerated vehicles for chilled orders · vans for `van_only` outlets · home depot only · vehicles in the workshop excluded · one brand and district per trip · at most 2 trips per vehicle · the Fresh 270 min and Style/Tech 480 min budgets (booklet formula) · weekly fuel quota (week-to-date ledger, round-trip litres) · delivery windows, using an operational timetable where early arrival waits, Fresh runs from 03:30, and the vehicle returns and reloads before trip 2 · orders closed at cutoff · every deferral has a reason.

## Departures from the Designathon submission

| Area | Designathon | Hackathon | Why |
|---|---|---|---|
| Role entry | Prototype role launcher | Real sign-in per role, with one-click demo-account buttons on the sign-in page | Access is tied to the signed-in account; the buttons keep the judge walkthrough fast. |
| Offline testing | Real loss of signal | Real offline support **plus** a *Simulate no signal* switch for the driver | Judges can test offline behaviour without airplane mode. |
| Capacity outlook (D4) | Forecast placement | Transparent seasonal-naive baseline from the order history, clearly labelled | The trained Datathon model is due on Day 15; the screen is ready to swap it in. |
| Order entry (S2) | Illustrative catalogue | Small illustrative catalogue of handling units converted to kg and m³ | The shared data has order totals, not a product master. |
| Demo reset | — | *Reset demo day* on D1 | Several judges share one deployment. |
| *(team: add any visual or flow changes compared with the Figma file)* | | | |

## Repository layout

```
apps/server     Express API (TypeScript): planner/, routes/, services/, seed/, schema.sql, tests
apps/web        React web app (Vite): pages per role, offline outbox, service worker
seed/data       Place the competition CSVs here (not committed; see its README)
docs/           Architecture, data model, AI tool disclosure
scripts/        export-s1.ts: planner output in Task 2B format, for the organizers' validator
```

## Deployment

The app runs as a Docker web service on Render (free instance) with its database on Supabase PostgreSQL. The database was seeded once from the competition files using `npm run seed -w apps/server` with `DATABASE_URL` and `DATABASE_SSL=true` set, so no data is in the image. Environment: `DATABASE_URL`, `DATABASE_SSL=true`, `JWT_SECRET`, with health check `/api/health`. The free instance sleeps after 15 minutes idle, so **the first request can take about a minute**. `render.yaml` is an optional Blueprint alternative using Render's own Postgres.

## Data use

The competition datasets are used only to seed the system and are **not committed**: the booklet's terms forbid publishing them or any derivatives. `docker compose up` reads them from `seed/data/` on your machine. The deployed instance was seeded directly into its database.
