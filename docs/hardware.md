# Hostinger KVM2 assessment

No SSH hostname, credentials or runtime telemetry were available in this
workspace, so the Hostinger VPS was not inspected and no deployment was
performed. The local machine's CPU/RAM would not be valid evidence for the VPS.

Run the following on the VPS during a maintenance window and save a redacted
report outside Git:

```sh
uname -a
nproc
free -h
swapon --show
df -hT
docker info --format '{{json .}}'
docker compose ps
docker stats --no-stream
ss -lntup
```

For browser sizing, run the offline mock browser/fixture workload first, then a
small authorized live sample only if the compliance gate is complete. Record
the API/RMA containers separately from the browser worker. Start with one
browser process and one context, then increase contexts and workers while
watching RSS, CPU steal, queue time and RMA request latency. Ten Chrome
processes are not a default and are not guaranteed to fit a KVM2 VPS.

If the RMA service approaches its CPU or memory budget, keep the API/web and
PostgreSQL on the existing host and place the browser worker on a separate
private, authenticated Linux host. Do not expose Redis or Playwright debugging
ports publicly.
