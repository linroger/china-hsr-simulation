# Tencent CVM + OceanBase Deployment Runbook

**Target host:** `43.160.208.85`
**Review date:** 2026-05-13
**Current access status:** SSH port 22 is reachable, but passwordless login as `root` and `ubuntu` was denied. The supplied `ssh-rsa ... skey-n37ar62j` value is a public key, not a login credential. To install on the CVM from this workspace, configure the matching private key, a valid username, or use the Tencent console to add this machine's public key to the instance.

## Recommendation

Hosting the simulation on the Tencent CVM makes sense, but the topology should be:

1. **Public:** Nginx on ports 80/443 serves the built React app and reverse-proxies API endpoints such as `/healthz`, `/ledger-stats`, and `/ingest-bookings`.
2. **Private:** OceanBase listens on `127.0.0.1:2881` or a private VPC address only. Do not expose port 2881 or ODP port 2883 directly to the Internet.
3. **Mapbox:** Keep using Mapbox's hosted style/tiles with a public `pk.` token in the frontend. Do not put the `sk.` token in browser code, docs, git, logs, or build artifacts.
4. **Migration:** Load `12306.db` into OceanBase through an SSH tunnel or by running the migration script on the CVM after copying the database and repo there.

I would not "host Mapbox" on the CVM unless the goal changes to self-hosting vector tiles with MapLibre/TileServer and an OSM extract. For this simulation, the CVM should host the app, API, generated GeoJSON/static assets, and OceanBase; Mapbox should remain the map rendering and style provider.

## Source References

- OceanBase quick start documents `obd demo`, all-in-one installation, and Docker quick-start options for single-machine experience deployments: <https://en.oceanbase.com/quickstart>
- OceanBase OBD single-node docs show `mini-single-example.yaml`, `obd cluster deploy`, `obd cluster start`, and tenant creation commands: <https://en.oceanbase.com/docs/community-obd-en-10000000003080906>
- OceanBase deployment preparations state that standalone mode is for experience environments, while production requires at least three servers; they also list minimum CPU, memory, and disk guidance: <https://oceanbase.github.io/docs/user_manual/quick_starts/en-US/chapter_02_deploy_oceanbase_database/preparation_before_deployment>
- Tencent Cloud CVM port docs state that Internet-facing services must be opened in security groups and that Linux login generally needs port 22: <https://www.tencentcloud.com/document/product/213/2502?lang=en>
- Mapbox token docs distinguish public `pk.` tokens for client-side apps from secret `sk.` tokens for server-side use: <https://docs.mapbox.com/help/faq/what-is-the-difference-between-a-public-token-and-a-secret-token/>

## Resource Sizing

For a demo/single-CVM deployment, use at least:

| Component | Minimum Practical Shape |
|---|---|
| OceanBase experience tenant | 2+ vCPU and at least 6 GB memory allocated to OceanBase. |
| Safer single-node CVM | 4 vCPU, 16 GB RAM, SSD disk. |
| Long-running production-like CVM | 8+ vCPU, 32 GB RAM, separate or roomy SSD storage. |
| True production OceanBase | At least 3 servers / zones, not a single CVM. |

The current `12306.db` is only about 60 MB, so storage is not the hard part. OceanBase itself preallocates data/log space and benefits from memory headroom.

## Security Group and Firewall Rules

Recommended Tencent security group:

| Port | Exposure | Purpose |
|---|---|---|
| 22/tcp | Your IP only | SSH administration. |
| 80/tcp | Public | HTTP redirect / certificate bootstrap. |
| 443/tcp | Public | HTTPS app/API. |
| 2881/tcp | Closed publicly | OceanBase direct MySQL protocol; use localhost or SSH tunnel. |
| 2883/tcp | Closed publicly | ODP, if deployed; use localhost or SSH tunnel. |
| 8680/tcp | Closed publicly | OBD Web, if temporarily used; access through SSH tunnel. |
| 3000/9090/tcp | Closed publicly | Grafana/Prometheus, if deployed; access through SSH tunnel. |

On the VM, also keep `ufw` or the OS firewall aligned with the Tencent security group:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 2881/tcp
sudo ufw deny 2883/tcp
sudo ufw enable
```

## OceanBase Installation Path

### Option A: OBD single-node deployment, recommended for this demo

Use this when the CVM has enough RAM and you want a real OceanBase process managed by OBD.

```bash
# Run after SSH access is fixed.
sudo apt-get update
sudo apt-get install -y curl ca-certificates net-tools chrony python3 python3-pip nginx git

# Use a non-root deployment user.
sudo useradd -m -s /bin/bash admin || true
sudo usermod -aG sudo admin
sudo mkdir -p /data /redo
sudo chown -R admin:admin /data /redo

sudo -iu admin
bash -c "$(curl -s https://obbusiness-private.oss-cn-shanghai.aliyuncs.com/download-center/opensource/oceanbase-all-in-one/installer.sh)"
source ~/.oceanbase-all-in-one/bin/env.sh
which obd
which obclient

# Fast experience deployment. Use OBD's printed connection string afterward.
obd demo
obd cluster list
obd cluster display demo
```

For a more explicit deployment, copy OBD's `mini-single-example.yaml`, set `home_path`, `data_dir`, `redo_dir`, `mysql_port: 2881`, `rpc_port: 2882`, `obshell_port: 2886`, and a root password, then run:

```bash
obd cluster deploy chinahsr_ob -c mini-single-example.yaml
obd cluster start chinahsr_ob
obd cluster display chinahsr_ob
obd cluster tenant create chinahsr_ob \
  -n chinahsr \
  --max-cpu=2 \
  --memory-size=2G \
  --log-disk-size=3G \
  --max-iops=10000 \
  --iops-weight=2 \
  --unit-num=1 \
  --charset=utf8 \
  -o htap \
  -s 'ob_tcp_invited_nodes="127.0.0.1,%"'
```

Keep the final tenant password in an environment file on the server, not in git.

### Option B: Docker quick start, useful only for a quick smoke test

Use this only if the CVM is a disposable demo environment:

```bash
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo docker run \
  -p 127.0.0.1:2881:2881 \
  --name obstandalone \
  -e MODE=MINI \
  -d quay.io/oceanbase/oceanbase-ce
```

This is convenient, but it is not the deployment I would trust for long-running simulation data.

## 12306 Migration Path

Preferred: keep OceanBase private and run the load through an SSH tunnel from this Mac.

```bash
ssh -N -L 2881:127.0.0.1:2881 <user>@43.160.208.85
```

Then, in another terminal from `ChinaHSR_Simulation`:

```bash
python3 -m pip install PyMySQL
export OB_HOST=127.0.0.1
export OB_PORT=2881
export OB_USER=root
export OB_DATABASE=chinahsr
export OB_PASSWORD='your-oceanbase-password'

npm run 12306:migrate -- \
  --sqlite /Users/rogerlin/Downloads/chinashsr/12306.db \
  --create-database \
  --truncate
```

Alternative: copy the repo and `12306.db` to the CVM and run the same command there with `OB_HOST=127.0.0.1`.

After load, run:

```sql
SELECT COUNT(*) FROM cr_12306_route_stop_sequences;
SELECT train_no, origin_station, terminal_station, stop_count
FROM cr_12306_route_stop_sequences
ORDER BY stop_count DESC
LIMIT 20;
SELECT train_route_id, from_order, from_station, to_station
FROM cr_12306_route_edges
WHERE train_route_id = 1
ORDER BY from_order;
```

Expected full-source row counts:

| Table | Expected Rows |
|---|---:|
| `cr_12306_stations` | 3,365 |
| `cr_12306_train_routes` | 388 |
| `cr_12306_route_stations` | 4,760 |
| `cr_12306_tickets` | 331 |
| `cr_12306_ticket_prices` | 1,271 |
| `cr_12306_railway_tracks` | 226,613 |
| `cr_12306_station_locations` | 3,345 |
| `cr_12306_station_track_links` | 15,865 |

## App Hosting Path

Build on the CVM or locally and upload `dist/`:

```bash
npm ci
VITE_MAPBOX_TOKEN='your-public-pk-token' \
VITE_MAPBOX_STYLE='mapbox://styles/linroger023/cmoo6ced0003m01sa25xq2hig' \
npm run build
```

Run the API/static server behind Nginx:

```ini
[Unit]
Description=China HSR Simulation
After=network.target

[Service]
WorkingDirectory=/opt/chinahsr/ChinaHSR_Simulation
Environment=HOST=127.0.0.1
Environment=PORT=5174
Environment=ENABLE_OB_INGEST=1
Environment=OB_HOST=127.0.0.1
Environment=OB_PORT=2881
Environment=OB_DATABASE=chinahsr
EnvironmentFile=/etc/chinahsr/oceanbase.env
ExecStart=/usr/bin/node scripts/serve-static.cjs
Restart=always
RestartSec=5
User=chinahsr

[Install]
WantedBy=multi-user.target
```

Minimal Nginx proxy:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5174;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add HTTPS with a domain and Certbot once DNS is pointed at the CVM.

## Acceptance Checklist

- [ ] SSH login works with a named user and private key.
- [ ] CVM resources are confirmed with `nproc`, `free -h`, and `df -h`.
- [ ] OceanBase starts and `obclient` can connect locally on `127.0.0.1:2881`.
- [ ] `cr_12306_` tables load with the expected row counts.
- [ ] Nginx serves the app over HTTP/HTTPS.
- [ ] Browser app uses only a public Mapbox token.
- [ ] OceanBase ports remain closed publicly; database access is local, VPC-only, or through an SSH tunnel.
- [ ] `/healthz`, `/ledger-stats`, and booking ingest endpoints return expected status from the CVM.
