# Running SVPCET Bus on your own machine

Live bus tracking for the SVPCET college bus, Nagalapuram → Puttur campus.

## What you need

**Node.js 20 or newer.** Check with:

```
node -v
```

If it prints something lower than `v20`, or "not recognised", install the LTS
version from https://nodejs.org and reopen your terminal.

Nothing else. No database, no API keys, no accounts.

## Get it running

Open the folder in VS Code, then open a terminal there
(**Terminal → New Terminal**) and run:

```
npm install
npm run dev
```

Then open **http://localhost:3100** in your browser.

That's it. The first `npm install` takes a couple of minutes; after that
`npm run dev` starts in a few seconds.

## The four screens

| Address | What it is |
|---|---|
| http://localhost:3100/ | **Track** — what students see |
| http://localhost:3100/drive | **Drive** — the phone on the bus broadcasts from here |
| http://localhost:3100/record | **Record** — ride the route once to map it |
| http://localhost:3100/admin | **Admin** — the transport office view |

Running locally there is no PIN, so all four open straight away. On the
deployed site the last three are behind one, set in the hosting environment.

## Seeing the bus move without a bus

There is a real recorded ride in the repo — 22 August 2026, Pichatur to campus.
Open **/drive**, choose Route 1, and press **Test playback**. The Track screen
will show the bus running that trip, with real timings.

## Trying it on a phone

`localhost` only works on the machine running it. Phones also refuse to give a
web page GPS access unless the page is served over https. Both are solved by:

```
npm run cert     # once — makes a local certificate
npm run host     # builds, then serves over the network
```

It prints an `https://192.168.x.x:3443` address and a QR code. Open that on a
phone on the **same Wi-Fi**. The browser will warn that the certificate is not
trusted — that is expected for a self-signed certificate on your own network;
choose Advanced → Proceed.

## Editing the route

Stops and the road the bus takes live in `scripts/seed.mjs`. After changing
them:

```
npm run seed
```

This rewrites `data/routes/`. It reuses the frozen road shape by default so the
line the bus follows cannot drift; pass `--refresh-shape` only if you genuinely
want it recalculated.

Useful checks:

```
npm run roads      # which real roads the route uses
npm run diagnose   # why GPS fixes are being rejected, if they are
```

## Where things are

```
src/app/            the four screens
src/lib/engine.ts   the tracking maths — GPS in, arrival times out
src/lib/geo.ts      projecting a GPS fix onto the route
src/components/     map, stop list, bottom sheet
scripts/seed.mjs    the route definition — stops and waypoints
data/routes/        the built route, committed so the app works out of the box
```

## If something goes wrong

**Port 3100 already in use** — something else is running on it. Close it, or
edit the `dev` script in `package.json` to use another port.

**The map is blank** — it needs internet for the background map tiles. The
route line, stops and bus are drawn from local data and will still appear.

**`npm install` fails** — check `node -v` is 20 or newer. That is nearly always
the cause.
