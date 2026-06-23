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

## Notes

- The app stores its data (location types, locations, caches) in the `data/`
  folder under the working directory, so make sure `pi` owns these files:
  `sudo chown -R pi:pi /home/pi/hammond-territory`.
- If you change the node path or install location, edit
  `ExecStart`/`WorkingDirectory`/`User` in
  `/etc/systemd/system/hammond-territory.service` then run
  `sudo systemctl daemon-reload && sudo systemctl restart hammond-territory`.
</content>
