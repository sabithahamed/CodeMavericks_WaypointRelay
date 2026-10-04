import { createApp } from './app.js';
import { seedAll } from './seed/seed.js';

const port = Number(process.env.PORT ?? 8080);

// Schema and seed are idempotent: a fresh database gets the shared datasets and the demo day.
for (let attempt = 1; ; attempt++) {
  try {
    await seedAll();
    break;
  } catch (e: any) {
    if (attempt >= 15) throw e;
    console.log(`Database not ready (${e.code ?? e.message}); retrying in 2s…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

createApp().listen(port, () => console.log(`Waypoint Relay listening on :${port}`));
