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

# Hashed static assets: cache for a long time
location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    include /etc/nginx/snippets/ets-headers.conf;   # an add_header here hides the server-level headers
    try_files $uri =404;
}

# Single-page app: every other path serves index.html
location / {
    add_header Cache-Control "no-cache";
    include /etc/nginx/snippets/ets-headers.conf;
    try_files $uri /index.html;
}
