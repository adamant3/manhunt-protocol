# Manhunt

A real-world GPS chase game for a group of friends, played in the browser on iPhone and Android.

## Playing

1. Open the site, enter your name, and host a game or join one with a 4-letter code.
2. In the lobby everyone picks a team. The host places the zone and sets the rules.
3. The host starts the game: every phone counts down from 10 together.
4. Runners hide and earn coins; chasers see a rough area around each runner at every ping and catch them by getting their 4-digit code in person.

Keep the screen on during a game. Browsers pause location in the background.

## Testing on one device

- `?as=2` gives a browser tab its own player identity, so two tabs can be two players.
- `?sim` turns off GPS: tap the map to move.

## Code

No build step. Static files served by Vercel; Supabase (Postgres + Realtime) for shared state.

- `index.html`, `css/app.css`
- `js/app.js` – screens, room lifecycle, GPS, wake lock
- `js/engine.js` – game rules (economy, pings, contracts, catches, power-ups)
- `js/ui.js` – screen rendering
- `js/net.js` – Supabase access and server clock
- `js/map.js` – Leaflet layers
- `js/config.js` – settings, contract deck, shop

Each phone writes only its own player row. Actions that affect other players (catches, freezes, power-ups) are appended to an `events` table that every phone reads. All timers are derived from the room's server start time.
