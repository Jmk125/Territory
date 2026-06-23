# Running Hammond Territory as a systemd service

These steps assume the app lives at `/home/pi/hammond-territory` and runs as
the `pi` user on a Raspberry Pi. Adjust paths/user if yours differ.

## 1. Get the code onto the Pi

```bash
git clone https://github.com/Jmk125/Territory.git /home/pi/hammond-territory
cd /home/pi/hammond-territory
```

(Or `git pull` if it's already there.)

## 2. Install Node.js (if not already installed)

```bash
node --version   # need v16+; if missing:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 3. Install dependencies

```bash
cd /home/pi/hammond-territory
npm install --omit=dev
```

## 4. Configure your environment

```bash
cp .env.example .env
nano .env          # paste your ORS_API_KEY, set PORT if you want
```

## 5. Install and start the service

```bash
# Confirm where node is — update ExecStart in the unit file if it differs
which node

sudo cp /home/pi/hammond-territory/deploy/hammond-territory.service \
        /etc/systemd/system/hammond-territory.service

sudo systemctl daemon-reload
sudo systemctl enable --now hammond-territory
```

## 6. Verify

```bash
systemctl status hammond-territory      # should say "active (running)"
journalctl -u hammond-territory -f      # live logs
```

Then open `http://<pi-ip>:3080` from another device on the network.

## Updating later

```bash
cd /home/pi/hammond-territory
git pull
npm install --omit=dev
sudo systemctl restart hammond-territory
```

## Common commands

| Action            | Command                                          |
|-------------------|--------------------------------------------------|
| Start             | `sudo systemctl start hammond-territory`         |
| Stop              | `sudo systemctl stop hammond-territory`          |
| Restart           | `sudo systemctl restart hammond-territory`       |
| Status            | `systemctl status hammond-territory`             |
| Live logs         | `journalctl -u hammond-territory -f`             |
| Disable autostart | `sudo systemctl disable hammond-territory`       |

## Drive-time isochrones (OpenRouteService)

The app draws drive-time isochrones by calling an ORS instance. You pick the
data source at runtime in the app: **Configure tab → ⚙ gear → Map Data Source**.

- **Public ORS API** — uses the `ORS_API_KEY` from `.env`. Capped at 60 min;
  longer ranges are approximated (the 60-min shape is padded outward and the
  coverage is labelled "approx").
- **Self-hosted ORS server** — enter your instance's address (e.g.
  `192.168.1.50:8082`, or a full `http://host:8082/ors` URL) and a drive-time
  limit that matches its config. The **Test** button checks the connection
  before you commit. Set `ORS_API_KEY` to any non-empty value — self-hosted ORS
  ignores auth.

The choice is saved to `data/settings.db` and persists across restarts. On a
fresh install the seed defaults come from `ORS_BASE_URL` / `ORS_MAX_RANGE_SEC`
in `.env` (see `.env.example`), so an existing env-based setup keeps working
until you change it from the gear.

Ranges above the active source's limit are approximated; everything at or below
it is a real ORS isochrone.

### Isochrones beyond 60 minutes return a circle?

ORS caps isochrone range at **3600s (60 min) by default**, even when
self-hosted. Requesting more (e.g. a 90-min/5400s isochrone) makes ORS reject
the request, and the app falls back to a plain circle (the rejection reason is
logged to the app console / `journalctl`).

Fix it on the ORS side by raising the isochrones endpoint's
`maximum_range_time` (seconds) and restarting the ORS container:

```yaml
# ors-config.yml
ors:
  endpoints:
    isochrones:
      maximum_range_time: 5400    # 90 minutes
```

Newer ORS versions express this as a per-profile list — match your config
file's existing format. The equivalent environment-variable override (handy
with the ORS Docker image) is:

```
ORS_ENDPOINTS_ISOCHRONES_MAXIMUM_RANGE_TIME=5400
```

After changing it, restart ORS and confirm the cap in the ORS startup logs.

## Notes

- The app stores its data (location types, locations, caches) in the `data/`
  folder under the working directory, so make sure `pi` owns these files:
  `sudo chown -R pi:pi /home/pi/hammond-territory`.
- If you change the node path or install location, edit
  `ExecStart`/`WorkingDirectory`/`User` in
  `/etc/systemd/system/hammond-territory.service` then run
  `sudo systemctl daemon-reload && sudo systemctl restart hammond-territory`.
</content>
