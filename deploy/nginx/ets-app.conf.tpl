# ETS — shared locations, installed to /etc/nginx/snippets/ets-app.conf by deploy/install.sh.
# Placeholder: __API_PORT__

access_log /var/log/nginx/ets.access.log;
error_log  /var/log/nginx/ets.error.log;

# Small request bodies everywhere; only the file-upload API routes below accept up to 6 MB (ETS-SEC-008).
client_max_body_size 128k;
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;

root /opt/ets/frontend/dist;
index index.html;

# API → Node.js backend
location /api/ {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    # a restore is running (the API is stopped on purpose): 503 + the maintenance page instead of 502
    error_page 502 503 504 = @ets_maintenance;
}
location @ets_maintenance {
    if (-f /var/lib/ets/restore/active) { return 503 '{"error":"maintenance_restore"}'; }
    return 502 '{"error":"api_unavailable"}';
}

# Live updates (Server-Sent Events, backend/src/routes/events.js): one long-lived response per open tab.
# No buffering, caching or compression (each event must reach the browser at once); the API sends a heartbeat
# every 25 s, so a 1 h read timeout only ends a stream whose API process stopped answering (the browser then
# reconnects). Exact match: no other path takes these settings.
location = /api/events {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Live alerts of the Android app (1.9.0, backend/src/routes/mobile.js): the same streaming settings as /api/events
# (Bearer device token instead of the cookie). Phones outside the building reach it over the organisation's VPN —
# never by opening the port to the internet (docs/handover/10-Operations-Runbook.md).
location = /api/m/events {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Phone pairing (no session): the login rate zone on top of the API's own limit (PAIR_RATE_LIMIT per 15 minutes).
location = /api/devices/pair {
    limit_req zone=ets_login burst=5 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# File uploads (team result imports, full tracker import, branding images): larger bodies.
# The API itself only reads them after authentication (backend/src/middleware/body.js).
location ~ ^/api/(imports|imports/preview|tracker/import|branding/[a-z_]+)$ {
    client_max_body_size 6m;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}

# Bulk user import (rows read from a spreadsheet in the browser): up to 1 MB, and time to hash up to 500
# passwords. The API reads the body only after the administrator check (backend/src/middleware/body.js).
location ~* ^/api/users/import(/preview)?/?$ {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}

# Brute-force protection on every endpoint that checks a password, 2FA code or recovery code.
# Case-insensitive and with an optional trailing slash, like the API's own routing (ETS-SEC-003).
location ~* ^/api/auth/(login|change-password|2fa/(verify|setup|enable|disable|recovery-codes))/?$ {
    limit_req zone=ets_login burst=5 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Backups (1.12.0): an encrypted backup file uploaded for a restore (Settings → «النسخ الاحتياطي»). The API streams it
# to disk after the administrator check and enforces its own limit (ETS_UPLOAD_MAX_MB, 4 GB by default).
location = /api/backups/upload {
    client_max_body_size 4g;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Progress of a restore (1.12.0), served by nginx because the API is stopped while the database is replaced.
# Read-only, no secrets (steps, percentage, counters, times; written by ets-backup-agent). Only the restore screens ask
# for it (they send X-ETS-Status: 1); any other request gets 404.
location = /api/restore-status.json {
    if ($http_x_ets_status != "1") { return 404; }
    alias /var/lib/ets/restore/status.json;
    default_type application/json;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;
}
# While the API is down for a restore (/var/lib/ets/restore/active exists) the pages show the maintenance page with the
# same progress bar; the API answers 503 there instead of 502.
location ~ ^/maintenance\.(html|js)$ {
    add_header Cache-Control "no-store";
    include /etc/nginx/snippets/ets-headers.conf;
}

# Hashed static assets: cache for a long time
location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    include /etc/nginx/snippets/ets-headers.conf;   # an add_header here hides the server-level headers
    try_files $uri =404;
}

# Single-page app: every other path serves index.html (the maintenance page during a restore)
location / {
    if (-f /var/lib/ets/restore/active) { rewrite ^ /maintenance.html last; }   # (/assets/ and /maintenance.js stay reachable)
    add_header Cache-Control "no-cache";
    include /etc/nginx/snippets/ets-headers.conf;
    try_files $uri /index.html;
}
